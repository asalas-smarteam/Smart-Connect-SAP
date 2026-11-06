import { jest } from '@jest/globals';
import {
  ACME,
  STAFF_PASSWORD,
  buildTokenApp,
  createToken,
  flush,
  hasKeyDeep,
  openTicket,
  send,
  storedTicket,
} from './panelTokenHarness.js';
import { staffUser } from '../application/panel/panelFakes.js';

const BY_CODE = '/staff/tickets/by-code/ACME-0012';
const WORK_LOG = `${BY_CODE}/work-log`;
const INVALID_TOKEN = { error: 'invalid_token', message: 'El token no es válido o venció. Crea uno nuevo en Mi cuenta.' };
const CHALLENGE = 'Bearer error="invalid_token"';
const BODY = Object.freeze({
  summary: 'Se corrigió el mapeo del campo de bodega; las cotizaciones ya llegan con el inventario.',
  internalNote: 'El mapeo apuntaba a la propiedad vieja. Se reprocesaron 14 eventos.',
  hours: 2.5,
  resolve: false,
  crmProjectId: '123456789',
});

function publish(ctx, { token, cookie, json = { ...BODY }, headers = {}, panelHeader, url = WORK_LOG } = {}) {
  return send(ctx.app, { method: 'POST', url, bearer: token, cookie, json, headers, panelHeader });
}

function expectInvalidToken(response) {
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual(INVALID_TOKEN);
  expect(response.headers['www-authenticate']).toBe(CHALLENGE);
}

describe('token authentication on the work log routes (contrato 12, M3)', () => {
  let ctx;
  let token;
  beforeEach(async () => {
    ctx = await buildTokenApp();
    token = await createToken(ctx);
    await openTicket(ctx);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('a valid token works on both routes without cookie (200 and 201)', async () => {
    const found = await send(ctx.app, { url: BY_CODE, bearer: token });
    const published = await publish(ctx, { token });

    expect(found.statusCode).toBe(200);
    expect(published.statusCode).toBe(201);
  });

  it.each(['bearer', 'BEARER', 'Bearer', 'bEaReR'])('accepts the scheme %s (case-insensitive) and surrounding spaces', async (scheme) => {
    const response = await send(ctx.app, { url: BY_CODE, authorization: `  ${scheme}   ${token}  ` });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['revoked', (c) => { c.apiTokenRepository.records[0].revokedAt = new Date(); }],
    ['expired', (c) => { c.apiTokenRepository.records[0].expiresAt = new Date(Date.now() - 1000); }],
    ['of an inactive user', (c) => { c.userRepository.users.find((user) => user.id === c.users.dev.id).active = false; }],
    ['of a client account', (c) => {
      const owner = c.userRepository.users.find((user) => user.id === c.users.dev.id);
      Object.assign(owner, { accountType: 'cliente', tenantKey: ACME, role: 'admin' });
    }],
  ])('a token %s answers 401 invalid_token with WWW-Authenticate on both routes', async (_label, mutate) => {
    mutate(ctx);

    expectInvalidToken(await send(ctx.app, { url: BY_CODE, bearer: token }));
    expectInvalidToken(await publish(ctx, { token }));
    expect(storedTicket(ctx, ctx.ticketRepository.tickets(ACME)[0].id).workLog ?? []).toHaveLength(0);
  });

  it('an unknown token with a valid format answers 401 invalid_token', async () => {
    expectInvalidToken(await send(ctx.app, { url: BY_CODE, bearer: `spn_${'Z'.repeat(43)}` }));
  });

  it.each([
    ['uppercase prefix', () => `Bearer SPN_${'a'.repeat(43)}`],
    ['42 characters', () => `Bearer spn_${'a'.repeat(42)}`],
    ['44 characters', () => `Bearer spn_${'a'.repeat(44)}`],
    ['padding =', () => `Bearer spn_${'a'.repeat(42)}=`],
    ['a +', () => `Bearer spn_${'a'.repeat(42)}+`],
    ['a /', () => `Bearer spn_${'a'.repeat(42)}/`],
    ['Basic scheme', (valid) => `Basic ${valid}`],
    ['Token scheme', (valid) => `Token ${valid}`],
    ['no token', () => 'Bearer'],
    ['two tokens', (valid) => `Bearer ${valid} ${valid}`],
    ['empty header', () => ''],
  ])('%s answers 401 invalid_token without looking the repository up', async (_label, header) => {
    const findByHash = jest.spyOn(ctx.apiTokenRepository, 'findByHash');

    expectInvalidToken(await send(ctx.app, { url: BY_CODE, authorization: header(token) }));
    expectInvalidToken(await publish(ctx, { token: undefined, headers: { authorization: header(token) } }));
    expect(findByHash).not.toHaveBeenCalled();
  });

  it('an owner with a pending password change gets 403 password_change_required on both routes', async () => {
    ctx.userRepository.users.find((user) => user.id === ctx.users.dev.id).mustChangePassword = true;

    const found = await send(ctx.app, { url: BY_CODE, bearer: token });
    const published = await publish(ctx, { token });

    expect(found.statusCode).toBe(403);
    expect(found.json()).toEqual({ error: 'password_change_required' });
    expect(published.statusCode).toBe(403);
    expect(published.json()).toEqual({ error: 'password_change_required' });
  });

  it('an invalid Authorization with a valid cookie answers 401 invalid_token (does not fall back to the cookie)', async () => {
    const found = await send(ctx.app, { url: BY_CODE, cookie: ctx.cookies.dev, authorization: 'Bearer nope' });
    const published = await publish(ctx, { cookie: ctx.cookies.dev, headers: { authorization: 'Bearer nope' } });

    expectInvalidToken(found);
    expectInvalidToken(published);
  });

  it('with a token the POST does not need X-Panel-Request; with the cookie it does', async () => {
    const withToken = await publish(ctx, { token, panelHeader: false });
    const cookieWithout = await publish(ctx, { cookie: ctx.cookies.dev, panelHeader: false });
    const cookieWith = await publish(ctx, { cookie: ctx.cookies.dev });

    expect(withToken.statusCode).toBe(201);
    expect(cookieWithout.statusCode).toBe(403);
    expect(cookieWithout.json()).toEqual({ error: 'missing_panel_header' });
    expect(cookieWith.statusCode).toBe(201);
  });

  it('without Authorization and without cookie answers 401 unauthorized', async () => {
    const found = await send(ctx.app, { url: BY_CODE });
    const published = await publish(ctx);

    expect(found.statusCode).toBe(401);
    expect(found.json()).toEqual({ error: 'unauthorized' });
    expect(published.statusCode).toBe(401);
    expect(published.json()).toEqual({ error: 'unauthorized' });
  });

  it('a client cookie answers 403 forbidden', async () => {
    const response = await send(ctx.app, { url: BY_CODE, cookie: ctx.cookies.client });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });
  });

  it.each([
    ['GET', '/staff/tickets'],
    ['GET', '/auth/me'],
    ['GET', `/staff/tenants/${ACME}/tickets/ffffffffffffffffffffffff`],
  ])('a valid token on %s %s without cookie answers 401 unauthorized and the repository is not used', async (method, url) => {
    const findByHash = jest.spyOn(ctx.apiTokenRepository, 'findByHash');

    const response = await send(ctx.app, { method, url, bearer: token });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(findByHash).not.toHaveBeenCalled();
  });

  it('the 31st request with the same token in a minute answers 429 with Retry-After', async () => {
    for (let index = 0; index < 30; index += 1) {
      const response = await send(ctx.app, { url: BY_CODE, bearer: token });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await send(ctx.app, { url: BY_CODE, bearer: token });
    const otherToken = await send(ctx.app, { url: BY_CODE, bearer: await createToken(ctx, ctx.users.otherDev, 'clave-de-luis') });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_attempts', message: 'Demasiados pedidos con este token. Espera un minuto.' });
    expect(blocked.headers['retry-after']).toBe('60');
    expect(otherToken.statusCode).toBe(200);
    // La clave del contador es el id del token, nunca el token.
    expect([...ctx.apiTokenAttempts.failures.keys()]).not.toContain(token);
  });

  it('lastUsedAt is set on the first use and not written again within the same minute', async () => {
    expect(ctx.apiTokenRepository.records[0].lastUsedAt).toBeNull();

    await send(ctx.app, { url: BY_CODE, bearer: token });
    await flush();
    const firstUse = ctx.apiTokenRepository.records[0].lastUsedAt;
    await send(ctx.app, { url: BY_CODE, bearer: token });
    await flush();

    expect(firstUse).toBeInstanceOf(Date);
    expect(ctx.apiTokenRepository.touches).toHaveLength(1);
    expect(ctx.apiTokenRepository.records[0].lastUsedAt).toBe(firstUse);
  });

  it('without the IP limiter, invalid tokens never answer 429', async () => {
    for (let index = 0; index < 25; index += 1) {
      expectInvalidToken(await send(ctx.app, { url: BY_CODE, authorization: 'Bearer nope' }));
    }
  });
});

describe('invalid tokens per IP (contrato 12, M7)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildTokenApp({ ipLimit: true });
    await openTicket(ctx);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('the 21st invalid token from the same IP answers 429 with Retry-After: 900, even for a valid token', async () => {
    for (let index = 0; index < 20; index += 1) {
      expectInvalidToken(await send(ctx.app, { url: BY_CODE, authorization: `Bearer spn_${'Z'.repeat(43)}` }));
    }

    const blocked = await send(ctx.app, { url: BY_CODE, authorization: 'Basic abc' });
    const valid = await send(ctx.app, { url: BY_CODE, bearer: await createToken(ctx) });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_attempts', message: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' });
    expect(blocked.headers['retry-after']).toBe('900');
    // Con la IP bloqueada, ni un token válido pasa: se corta antes de resolverlo.
    expect(valid.statusCode).toBe(429);
    expect(valid.headers['retry-after']).toBe('900');
  });

  it('a valid token does not consume the IP counter', async () => {
    const token = await createToken(ctx);
    for (let index = 0; index < 19; index += 1) {
      expectInvalidToken(await send(ctx.app, { url: BY_CODE, authorization: 'Bearer nope' }));
    }
    for (let index = 0; index < 5; index += 1) {
      expect((await send(ctx.app, { url: BY_CODE, bearer: token })).statusCode).toBe(200);
    }

    expectInvalidToken(await send(ctx.app, { url: BY_CODE, authorization: 'Bearer nope' }));
    expect((await send(ctx.app, { url: BY_CODE, authorization: 'Bearer nope' })).statusCode).toBe(429);
  });

  it('with the IP already blocked answers 429 without resolving the token (the repository is not used)', async () => {
    const token = await createToken(ctx);
    for (let index = 0; index < 21; index += 1) {
      await send(ctx.app, { url: BY_CODE, bearer: `spn_${'Z'.repeat(43)}` });
    }
    const findByHash = jest.spyOn(ctx.apiTokenRepository, 'findByHash');
    const consume = jest.spyOn(ctx.invalidTokenIpAttempts, 'consume');

    const unknown = await send(ctx.app, { url: BY_CODE, bearer: `spn_${'Y'.repeat(43)}` });
    const valid = await publish(ctx, { token });

    for (const response of [unknown, valid]) {
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: 'too_many_attempts', message: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' });
      expect(response.headers['retry-after']).toBe('900');
    }
    expect(findByHash).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(storedTicket(ctx, ctx.ticketRepository.tickets(ACME)[0].id).workLog ?? []).toHaveLength(0);
  });

  it('without a usable client IP the IP limiter is not used (no shared null key)', async () => {
    for (let index = 0; index < 25; index += 1) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/panel/api${BY_CODE}`,
        remoteAddress: 'unknown',
        headers: { authorization: 'Bearer nope' },
      });
      expectInvalidToken(response);
    }

    expect(ctx.invalidTokenIpAttempts.failures.size).toBe(0);
  });
});

describe('GET /staff/tickets/by-code/:code (contrato 12, M4)', () => {
  let ctx;
  let token;
  let ticket;
  beforeEach(async () => {
    ctx = await buildTokenApp();
    token = await createToken(ctx);
    ticket = await openTicket(ctx, { status: 'en_progreso' });
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('answers 200 with the ticket summary and does not mark it as seen by Smarteam', async () => {
    const before = storedTicket(ctx, ticket.id).staffLastSeenAt ?? null;

    const response = await send(ctx.app, { url: BY_CODE, bearer: token });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenantKey: ACME,
      id: ticket.id,
      code: 'ACME-0012',
      title: 'La cotización no llegó',
      companyName: 'Acme Industrial',
      status: 'en_progreso',
      openedAt: new Date(ticket.openedAt).toISOString(),
    });
    expect(storedTicket(ctx, ticket.id).staffLastSeenAt ?? null).toEqual(before);
  });

  it('normalizes the code (lowercase and spaces)', async () => {
    const response = await send(ctx.app, { url: '/staff/tickets/by-code/%20acme-0012%20', bearer: token });

    expect(response.statusCode).toBe(200);
    expect(response.json().code).toBe('ACME-0012');
  });

  it('finds a 5-digit number', async () => {
    await openTicket(ctx, { number: 12345 });

    const response = await send(ctx.app, { url: '/staff/tickets/by-code/ACME-12345', bearer: token });

    expect(response.statusCode).toBe(200);
    expect(response.json().code).toBe('ACME-12345');
  });

  it.each(['ACME-9999', 'NOEXISTE-0001', 'ACME0012'])('answers 404 not_found for %s', async (code) => {
    ctx.ticketRepository.touchedTenants.length = 0;

    const response = await send(ctx.app, { url: `/staff/tickets/by-code/${code}`, bearer: token });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    if (code !== 'ACME-9999') {
      expect(ctx.ticketRepository.touchedTenants).toEqual([]);
    }
  });

  it('answers 409 ambiguous_code when two companies give the same prefix and number', async () => {
    ctx.tenantDirectory.tenants.push({ tenantKey: 'acme', companyName: 'Acme Duplicada', status: 'active' });
    await openTicket(ctx, { tenantKey: 'acme' });

    const response = await send(ctx.app, { url: BY_CODE, bearer: token });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'ambiguous_code' });
  });

  it('also works with a staff cookie', async () => {
    const response = await send(ctx.app, { url: BY_CODE, cookie: ctx.cookies.dev });

    expect(response.statusCode).toBe(200);
  });
});

describe('POST /staff/tickets/by-code/:code/work-log (contrato 12, M5 y M6)', () => {
  let ctx;
  let token;
  let ticket;
  beforeEach(async () => {
    ctx = await buildTokenApp();
    token = await createToken(ctx);
    ticket = await openTicket(ctx);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('publishes: 201 with the entry, public message by the token owner and en_progreso', async () => {
    const response = await publish(ctx, { token });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual({
      entry: {
        id: expect.any(String),
        author: { name: 'Ana Mora' },
        hours: 2.5,
        internalNote: BODY.internalNote,
        crmProjectId: '123456789',
        createdAt: expect.any(String),
        messageId: expect.any(String),
      },
      ticket: { status: 'en_progreso' },
    });
    const saved = storedTicket(ctx, ticket.id);
    expect(saved.status).toBe('en_progreso');
    expect(saved.workLog).toHaveLength(1);
    const message = saved.messages.find((candidate) => candidate.id === body.entry.messageId);
    expect(message).toMatchObject({ authorType: 'smarteam', authorName: 'Ana Mora', body: BODY.summary });
    expect(ctx.auditLog.entries.find((entry) => entry.action === 'ticket.work_logged').details)
      .toMatchObject({ via: 'token', tokenPrefix: ctx.apiTokenRepository.records[0].prefix, hours: 2.5, resolved: false });
  });

  it('with the cookie the entry is recorded via session', async () => {
    const response = await publish(ctx, { cookie: ctx.cookies.dev });

    expect(response.statusCode).toBe(201);
    expect(storedTicket(ctx, ticket.id).workLog[0]).toMatchObject({ via: 'session', tokenId: null });
  });

  it.each([
    ['hours as text', { hours: '2.5' }],
    ['hours null', { hours: null }],
    ['hours 0.2', { hours: 0.2 }],
    ['hours 24.25', { hours: 24.25 }],
    ['an empty summary', { summary: '' }],
    ['a 5001-character summary', { summary: 'x'.repeat(5001) }],
    ['resolve without internalNote', { resolve: true, internalNote: '' }],
    ['a 65-character crmProjectId', { crmProjectId: 'x'.repeat(65) }],
  ])('answers 400 validation_error for %s and leaves the ticket untouched', async (_label, patch) => {
    const response = await publish(ctx, { token, json: { ...BODY, ...patch } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
    expect(storedTicket(ctx, ticket.id).workLog ?? []).toHaveLength(0);
    expect(storedTicket(ctx, ticket.id).status).toBe('abierto');
  });

  it.each([
    ['text/plain', 'text/plain', JSON.stringify(BODY)],
    ['form-urlencoded', 'application/x-www-form-urlencoded', 'summary=hola&hours=1'],
    ['multipart', 'multipart/form-data; boundary=abc', '--abc\r\nContent-Disposition: form-data; name="summary"\r\n\r\nhola\r\n--abc--\r\n'],
  ])('answers 400 validation_error for a %s body', async (_label, contentType, payload) => {
    const response = await send(ctx.app, { method: 'POST', url: WORK_LOG, bearer: token, payload, contentType });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message: 'El cuerpo debe ser JSON (Content-Type: application/json).' });
    expect(storedTicket(ctx, ticket.id).workLog ?? []).toHaveLength(0);
  });

  it('answers 400 validation_error for invalid JSON', async () => {
    const response = await send(ctx.app, { method: 'POST', url: WORK_LOG, bearer: token, payload: '{"summary":', contentType: 'application/json' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it.each(['con espacio', 'a/b', '', 'k'.repeat(129)])('answers 400 for the Idempotency-Key %j', async (key) => {
    const response = await publish(ctx, { token, headers: { 'idempotency-key': key } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('answers 409 invalid_transition on a resolved ticket and publishes nothing', async () => {
    storedTicket(ctx, ticket.id).status = 'resuelto';
    const before = structuredClone(storedTicket(ctx, ticket.id));

    const response = await publish(ctx, { token });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'invalid_transition',
      message: 'El ticket ya está resuelto. Pásalo a en progreso desde el panel para registrar más trabajo.',
    });
    expect(storedTicket(ctx, ticket.id)).toEqual(before);
  });

  it('answers 404 not_found for an unknown code', async () => {
    const response = await publish(ctx, { token, url: '/staff/tickets/by-code/ACME-9999/work-log' });

    expect(response.statusCode).toBe(404);
  });

  it('replays the same Idempotency-Key with the same response, one entry and one message', async () => {
    const headers = { 'idempotency-key': 'b6f1c7a2-1d2e-4f3a-9b8c-0d1e2f3a4b5c' };
    const first = await publish(ctx, { token, headers });
    const messagesAfterFirst = storedTicket(ctx, ticket.id).messages.length;
    // Normalización: la nota vacía o ausente y un campo desconocido no cambian la huella.
    const second = await publish(ctx, { token, headers, json: { ...BODY, extra: 'ignorado' } });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(storedTicket(ctx, ticket.id).workLog).toHaveLength(1);
    expect(storedTicket(ctx, ticket.id).messages).toHaveLength(messagesAfterFirst);
  });

  it('answers 422 idempotency_key_reused for the same key with another body', async () => {
    const headers = { 'idempotency-key': 'clave-1' };
    await publish(ctx, { token, headers });

    const response = await publish(ctx, { token, headers, json: { ...BODY, hours: 3 } });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'idempotency_key_reused' });
    expect(storedTicket(ctx, ticket.id).workLog).toHaveLength(1);
  });

  it('the same key from another token is processed as new', async () => {
    const headers = { 'idempotency-key': 'clave-compartida' };
    const otherToken = await createToken(ctx, ctx.users.dev, STAFF_PASSWORD, 'Otra laptop');
    await publish(ctx, { token, headers });

    const response = await publish(ctx, { token: otherToken, headers });

    expect(response.statusCode).toBe(201);
    expect(storedTicket(ctx, ticket.id).workLog).toHaveLength(2);
  });

  it('a 400 first and a corrected retry with the same key answers 201', async () => {
    const headers = { 'idempotency-key': 'clave-reintento' };
    const bad = await publish(ctx, { token, headers, json: { ...BODY, hours: 0 } });
    const good = await publish(ctx, { token, headers });

    expect(bad.statusCode).toBe(400);
    expect(good.statusCode).toBe(201);
  });

  it('the staff detail brings workLog, newest first, with totalHours', async () => {
    await publish(ctx, { token });
    await publish(ctx, { token, json: { ...BODY, hours: 1.75, internalNote: '' } });

    const response = await send(ctx.app, { url: `/staff/tenants/${ACME}/tickets/${ticket.id}`, cookie: ctx.cookies.dev });

    expect(response.statusCode).toBe(200);
    const { workLog } = response.json();
    expect(workLog.totalHours).toBe(4.25);
    expect(workLog.entries).toHaveLength(2);
    expect(Date.parse(workLog.entries[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(workLog.entries[1].createdAt));
  });

  it('a staff detail without entries brings { totalHours: 0, entries: [] }', async () => {
    const response = await send(ctx.app, { url: `/staff/tenants/${ACME}/tickets/${ticket.id}`, cookie: ctx.cookies.dev });

    expect(response.json().workLog).toEqual({ totalHours: 0, entries: [] });
  });

  it('the client never receives workLog, hours, internalNote or crmProjectId (detail, list, metrics)', async () => {
    await publish(ctx, { token, json: { ...BODY, resolve: true } });

    const detail = await send(ctx.app, { url: `/tickets/${ticket.id}`, cookie: ctx.cookies.client });
    const list = await send(ctx.app, { url: '/tickets', cookie: ctx.cookies.client });
    const from = new Date(Date.now() - 2 * 86400000).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();
    const metrics = await send(ctx.app, { url: `/tickets/metrics?from=${from}&to=${to}&tz=America%2FCosta_Rica`, cookie: ctx.cookies.client });

    for (const response of [detail, list, metrics]) {
      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const key of ['workLog', 'hours', 'internalNote', 'crmProjectId']) {
        expect(hasKeyDeep(body, key)).toBe(false);
      }
    }
    // El cliente sí ve el resumen como mensaje de Smarteam.
    expect(detail.json().messages.map((message) => message.body)).toContain(BODY.summary);
  });
});

describe('pending password change with a cookie on the token routes', () => {
  it('a cookie session with a pending change answers 403 password_change_required', async () => {
    const pending = staffUser({ email: 'pendiente@smarteam.test', mustChangePassword: true });
    const ctx = await buildTokenApp({ extraUsers: [pending] });
    try {
      const { default: HmacSessionToken } = await import('../../../src/infrastructure/auth/HmacSessionToken.js');
      const { SECRET } = await import('./panelTokenHarness.js');
      const cookie = `panel_session=${new HmacSessionToken({ secret: SECRET }).sign({ sub: pending.id, tv: 0, pwdChange: true })}`;

      const response = await send(ctx.app, { url: BY_CODE, cookie });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'password_change_required' });
    } finally {
      await ctx.app.close();
    }
  });
});
