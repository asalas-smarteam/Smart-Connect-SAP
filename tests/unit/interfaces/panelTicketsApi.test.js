import { jest } from '@jest/globals';
import Fastify from 'fastify';
import panelPlugin from '../../../src/interfaces/http/panel/panelPlugin.js';
import { buildPanelUseCases } from '../../../src/composition/panel.composition.js';
import HmacSessionToken from '../../../src/infrastructure/auth/HmacSessionToken.js';
import {
  FakeLoginAttempts,
  FakePasswordHasher,
  FakeRevokedSessions,
  FakeTenantDirectory,
  InMemoryPanelUserRepository,
  RecordingAuditLog,
  SequenceTemporaryPassword,
  TENANTS,
  clientUser,
  staffUser,
} from '../application/panel/panelFakes.js';
import {
  FakeAttachmentStore,
  FakeContextReader,
  InMemoryTicketRepository,
  JPEG,
  PNG,
  SVG,
} from '../application/panel/ticketFakes.js';

const SECRET = 'panel-tickets-api-secret-with-32-chars';
const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const EVENT_ID = '6711a0b1c2d3e4f501234567';

// Cuerpo multipart armado a mano: texto como campos y archivos en `images` (contrato D6).
function multipart(fields = {}, files = []) {
  const boundary = '----panelTicketsBoundary7MA4YWxk';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const { field = 'images', filename = 'captura.png', type = 'image/png', data } of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
    chunks.push(data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function buildApp() {
  const staff = staffUser();
  const ana = clientUser({ email: 'ana@acme.test', name: 'Ana Mora' });
  const otro = clientUser({ email: 'otro@initech.test', name: 'Otro', tenantKey: INITECH });
  const tokens = new HmacSessionToken({ secret: SECRET });
  const ticketRepository = new InMemoryTicketRepository();
  const attachmentStore = new FakeAttachmentStore();
  const contextReader = new FakeContextReader({
    events: { [ACME]: { [EVENT_ID]: { _id: EVENT_ID, eventType: 'createQuotation', status: 'errored', lastError: 'boom', payload: { deal: { hs_object_id: '9' } }, sapAudit: { x: 1 } } } },
  });
  const useCases = buildPanelUseCases({
    secret: SECRET,
    userRepository: new InMemoryPanelUserRepository([staff, ana, otro]),
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    passwordHasher: new FakePasswordHasher(),
    temporaryPasswordGenerator: new SequenceTemporaryPassword(),
    loginAttempts: new FakeLoginAttempts(),
    auditLog: new RecordingAuditLog(),
    revokedSessions: new FakeRevokedSessions(),
    sessionToken: tokens,
    ticketRepository,
    attachmentStore,
    contextReader,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  });

  const app = Fastify();
  app.post('/outside', async (req) => ({ body: req.body ?? null }));
  app.register(panelPlugin, {
    prefix: '/panel/api',
    secret: SECRET,
    useCases,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  });
  await app.ready();

  const cookieFor = (user) => `panel_session=${tokens.sign({ sub: user.id, tv: 0, pwdChange: false })}`;
  return {
    app,
    ticketRepository,
    attachmentStore,
    cookies: { staff: cookieFor(staff), ana: cookieFor(ana), otro: cookieFor(otro) },
  };
}

function send(app, { method = 'GET', url, cookie, form, json, headers = {} }) {
  const options = { method, url: `/panel/api${url}`, headers: { ...headers } };
  if (cookie) {
    options.headers.cookie = cookie;
  }
  if (method !== 'GET') {
    options.headers['x-panel-request'] = '1';
  }
  if (form) {
    options.payload = form.payload;
    options.headers['content-type'] = form.contentType;
  }
  if (json !== undefined) {
    options.payload = json;
  }
  return app.inject(options);
}

function createTicket(ctx, cookie = ctx.cookies.ana, fields = {}, files = []) {
  return send(ctx.app, {
    method: 'POST',
    url: '/tickets',
    cookie,
    form: multipart({ title: 'No llegó', description: 'Detalle', category: 'documentos', ...fields }, files),
  });
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([name, nested]) => name === key || hasKeyDeep(nested, key));
}

describe('/panel/api tickets — client', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('creates a ticket from multipart with images and answers 201 with id and code (D7)', async () => {
    const response = await createTicket(ctx, ctx.cookies.ana, {}, [{ data: PNG }, { data: JPEG, filename: 'b.jpg', type: 'image/jpeg' }]);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual(expect.objectContaining({ code: 'ACME-0001', status: 'abierto' }));
    expect(body.id).toMatch(/^[0-9a-f]{24}$/);
    expect(body.attachments.map((attachment) => attachment.contentType)).toEqual(['image/png', 'image/jpeg']);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('links an event of its tenant and keeps only the generic snapshot', async () => {
    const response = await createTicket(ctx, ctx.cookies.ana, { contextType: 'webhookEvent', contextId: EVENT_ID });

    expect(response.statusCode).toBe(201);
    expect(response.json().context.snapshot).toEqual(expect.objectContaining({ type: 'createQuotation', status: 'errored', reference: '9' }));
    expect(JSON.stringify(response.json())).not.toContain('sapAudit');
  });

  it('answers 404 for an event of another tenant (D11)', async () => {
    const response = await createTicket(ctx, ctx.cookies.otro, { contextType: 'webhookEvent', contextId: EVENT_ID });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it.each([
    ['six images', Array.from({ length: 6 }, () => ({ data: PNG })), 400, 'too_many_images'],
    ['an image over 5 MB', [{ data: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) }], 413, 'image_too_large'],
    ['an SVG renamed to .png', [{ data: SVG }], 400, 'invalid_image'],
  ])('rejects %s (D9)', async (_label, files, status, error) => {
    const response = await createTicket(ctx, ctx.cookies.ana, {}, files);

    expect(response.statusCode).toBe(status);
    expect(response.json().error).toBe(error);
    expect(ctx.ticketRepository.tickets(ACME)).toHaveLength(0);
  });

  it('rejects images sent under another field name', async () => {
    const response = await createTicket(ctx, ctx.cookies.ana, {}, [{ field: 'images[]', data: PNG }]);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('rejects a form whose declared size is over the limit without reading it', async () => {
    const form = multipart({ title: 'x' });
    const response = await send(ctx.app, {
      method: 'POST',
      url: '/tickets',
      cookie: ctx.cookies.ana,
      form,
      headers: { 'content-length': String(27 * 1024 * 1024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('image_too_large');
  });

  it('answers validation_error with a readable message', async () => {
    const response = await createTicket(ctx, ctx.cookies.ana, { title: '' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message: 'El título es obligatorio.' });
  });

  it('answers validation_error to a JSON body where a form is expected', async () => {
    const response = await send(ctx.app, { method: 'POST', url: '/tickets', cookie: ctx.cookies.ana, json: { title: 'x' } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('ignores any tenantKey the client tries to send', async () => {
    await createTicket(ctx, ctx.cookies.otro);
    const created = await createTicket(ctx, ctx.cookies.ana, { tenantKey: INITECH });

    const list = await send(ctx.app, {
      url: `/tickets?tenantKey=${INITECH}`,
      cookie: ctx.cookies.ana,
      headers: { 'x-tenant-id': INITECH },
    });

    expect(created.json().code).toBe('ACME-0001');
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item) => item.code)).toEqual(['ACME-0001']);
  });

  it('never returns internalResolution to a client (list, detail, create, reply, reopen)', async () => {
    const created = (await createTicket(ctx)).json();
    const stored = ctx.ticketRepository.tickets(ACME)[0];
    stored.internalResolution = { text: 'nota-secreta', updatedAt: new Date(), updatedBy: { name: 'Dev' } };

    const responses = [created];
    responses.push((await send(ctx.app, { url: '/tickets', cookie: ctx.cookies.ana })).json());
    responses.push((await send(ctx.app, { url: `/tickets/${created.id}`, cookie: ctx.cookies.ana })).json());
    responses.push((await send(ctx.app, { method: 'POST', url: `/tickets/${created.id}/messages`, cookie: ctx.cookies.ana, form: multipart({ body: 'hola' }) })).json());
    stored.status = 'resuelto';
    responses.push((await send(ctx.app, { method: 'POST', url: `/tickets/${created.id}/reopen`, cookie: ctx.cookies.ana, json: { message: 'Sigue fallando' } })).json());

    for (const body of responses) {
      expect(hasKeyDeep(body, 'internalResolution')).toBe(false);
      expect(JSON.stringify(body)).not.toContain('nota-secreta');
    }
  });

  it('answers 404 for a ticket of another tenant and 409 on a resolved ticket', async () => {
    const foreign = (await createTicket(ctx, ctx.cookies.otro)).json();
    const own = (await createTicket(ctx)).json();
    ctx.ticketRepository.tickets(ACME)[0].status = 'resuelto';

    const crossed = await send(ctx.app, { url: `/tickets/${foreign.id}`, cookie: ctx.cookies.ana });
    const blocked = await send(ctx.app, { method: 'POST', url: `/tickets/${own.id}/messages`, cookie: ctx.cookies.ana, form: multipart({ body: 'x' }) });

    expect(crossed.statusCode).toBe(404);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: 'invalid_transition' });
  });

  it('serves an image with the contract headers (D10), only within its ticket', async () => {
    const created = (await createTicket(ctx, ctx.cookies.ana, {}, [{ data: PNG }])).json();
    const { fileId } = created.attachments[0];

    const response = await send(ctx.app, { url: `/tickets/${created.id}/attachments/${fileId}`, cookie: ctx.cookies.ana });
    const foreign = await send(ctx.app, { url: `/tickets/${created.id}/attachments/${fileId}`, cookie: ctx.cookies.otro });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.rawPayload.equals(PNG)).toBe(true);
    expect(foreign.statusCode).toBe(404);
  });

  it('answers 403 to Smarteam on client routes', async () => {
    const response = await send(ctx.app, { url: '/tickets', cookie: ctx.cookies.staff });

    expect(response.statusCode).toBe(403);
  });
});

describe('/panel/api tickets — Smarteam', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('runs the whole flow with the contract routes', async () => {
    const { id } = (await createTicket(ctx)).json();
    const base = `/staff/tenants/${ACME}/tickets/${id}`;

    const inbox = await send(ctx.app, { url: '/staff/tickets', cookie: ctx.cookies.staff });
    expect(inbox.json()).toEqual(expect.objectContaining({ total: 1, warnings: [] }));
    expect(inbox.json().items[0]).toEqual(expect.objectContaining({ tenantKey: ACME, companyName: 'Acme Industrial', hasNews: true }));

    const replied = await send(ctx.app, { method: 'POST', url: `${base}/messages`, cookie: ctx.cookies.staff, form: multipart({ body: 'Lo revisamos' }, [{ data: PNG }]) });
    expect(replied.statusCode).toBe(201);
    expect(replied.json().status).toBe('en_progreso');

    const waiting = await send(ctx.app, { method: 'POST', url: `${base}/status`, cookie: ctx.cookies.staff, json: { to: 'esperando_cliente' } });
    expect(waiting.json().status).toBe('esperando_cliente');

    const invalid = await send(ctx.app, { method: 'POST', url: `${base}/status`, cookie: ctx.cookies.staff, json: { to: 'resuelto' } });
    expect(invalid.statusCode).toBe(409);

    const resolved = await send(ctx.app, {
      method: 'POST',
      url: `${base}/resolve`,
      cookie: ctx.cookies.staff,
      form: multipart({ message: 'Listo', internalResolution: 'Causa raíz' }),
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().internalResolution.text).toBe('Causa raíz');

    const note = await send(ctx.app, { method: 'PUT', url: `${base}/internal-resolution`, cookie: ctx.cookies.staff, json: { text: 'Causa corregida' } });
    expect(note.json().internalResolution.text).toBe('Causa corregida');

    const detail = await send(ctx.app, { url: base, cookie: ctx.cookies.staff });
    expect(detail.json()).toEqual(expect.objectContaining({ status: 'resuelto', tenantKey: ACME }));

    const fileId = replied.json().messages[0].attachments[0].fileId;
    const image = await send(ctx.app, { url: `${base}/attachments/${fileId}`, cookie: ctx.cookies.staff });
    expect(image.statusCode).toBe(200);
    expect(image.headers['cache-control']).toBe('private');

    const summary = await send(ctx.app, { url: '/staff/tickets/summary', cookie: ctx.cookies.staff });
    expect(summary.json().byStatus).toEqual({ abierto: 0, en_progreso: 0, esperando_cliente: 0, resuelto: 1 });
  });

  it('answers 404 for an unknown tenant without touching any database', async () => {
    const response = await send(ctx.app, { url: '/staff/tenants/sap_integration_fantasma/tickets/ffffffffffffffffffffffff', cookie: ctx.cookies.staff });

    expect(response.statusCode).toBe(404);
    expect(ctx.ticketRepository.touchedTenants).toEqual([]);
  });

  it('answers page_window_exceeded on the inbox', async () => {
    const response = await send(ctx.app, { url: '/staff/tickets?page=11&pageSize=100', cookie: ctx.cookies.staff });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('page_window_exceeded');
  });

  it('answers 403 to a client on every staff ticket route', async () => {
    const response = await send(ctx.app, { url: '/staff/tickets', cookie: ctx.cookies.ana });

    expect(response.statusCode).toBe(403);
  });
});

describe('multipart stays inside /panel/api', () => {
  it('the rest of the API still rejects multipart bodies', async () => {
    const ctx = await buildApp();
    const form = multipart({ a: '1' });

    const response = await ctx.app.inject({ method: 'POST', url: '/outside', payload: form.payload, headers: { 'content-type': form.contentType } });

    expect(response.statusCode).toBe(415);
    await ctx.app.close();
  });
});
