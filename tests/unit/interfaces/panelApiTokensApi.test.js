import { jest } from '@jest/globals';
import { STAFF_PASSWORD, buildTokenApp, createToken, send } from './panelTokenHarness.js';

const TOKEN_FORMAT = /^spn_[A-Za-z0-9_-]{43}$/;
const INVALID_CURRENT_PASSWORD = { error: 'invalid_current_password', message: 'La contraseña actual no es correcta.' };

function createRequest(ctx, { cookie = ctx.cookies.dev, json = { name: 'Claude Code - laptop', currentPassword: STAFF_PASSWORD }, ...rest } = {}) {
  return send(ctx.app, { method: 'POST', url: '/account/api-tokens', cookie, json, ...rest });
}

describe('/panel/api/account/api-tokens (contrato 12, M2)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildTokenApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('creates a token: 201 with spn_ + 43 base64url, prefix = first 8 and only the hash stored', async () => {
    const response = await createRequest(ctx);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.token).toMatch(TOKEN_FORMAT);
    expect(body.item).toEqual({
      id: expect.any(String),
      name: 'Claude Code - laptop',
      prefix: body.token.slice(0, 8),
      createdAt: expect.any(String),
      lastUsedAt: null,
      expiresAt: expect.any(String),
    });
    const days = (Date.parse(body.item.expiresAt) - Date.parse(body.item.createdAt)) / 86400000;
    expect(days).toBe(90);
    expect(JSON.stringify(ctx.apiTokenRepository.records)).not.toContain(body.token);
    expect(ctx.apiTokenRepository.records[0].tokenHash).toBe(ctx.apiTokenCodec.hash(body.token));
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['61 characters', 'x'.repeat(61)],
    ['a line break', 'Claude\nCode'],
    ['a tab', 'Claude\tCode'],
    ['a NUL', 'Claude\u0000Code'],
  ])('answers 400 validation_error for a name with %s', async (_label, name) => {
    const response = await createRequest(ctx, { json: { name, currentPassword: STAFF_PASSWORD } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
    expect(ctx.apiTokenRepository.records).toHaveLength(0);
  });

  it('answers 400 validation_error without currentPassword', async () => {
    const response = await createRequest(ctx, { json: { name: 'Laptop' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message: 'Escribe tu contraseña actual.' });
  });

  it('answers 400 invalid_current_password with a wrong password (same body as change-password) and creates nothing', async () => {
    const response = await createRequest(ctx, { json: { name: 'Laptop', currentPassword: 'otra' } });
    const change = await send(ctx.app, {
      method: 'POST',
      url: '/auth/change-password',
      cookie: ctx.cookies.dev,
      json: { currentPassword: 'otra', newPassword: 'NuevaClave2026!' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(INVALID_CURRENT_PASSWORD);
    expect(change.statusCode).toBe(400);
    expect(change.json()).toEqual(response.json());
    expect(ctx.apiTokenRepository.records).toHaveLength(0);
  });

  it('answers 429 with Retry-After on the sixth wrong password, even if it is correct', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await createRequest(ctx, { json: { name: 'Laptop', currentPassword: 'otra' } });
      expect(wrong.statusCode).toBe(400);
    }

    const sixth = await createRequest(ctx);

    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('too_many_attempts');
    expect(sixth.headers['retry-after']).toBe('900');
    expect(ctx.apiTokenRepository.records).toHaveLength(0);
  });

  it('answers 409 token_limit with the correct password and 5 active tokens', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await createRequest(ctx)).statusCode).toBe(201);
    }

    const response = await createRequest(ctx);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'token_limit', message: 'Ya tienes 5 tokens activos. Revoca uno para crear otro.' });
  });

  it('lists only the active tokens of the session user, newest first, without token or tokenHash', async () => {
    const first = (await createRequest(ctx, { json: { name: 'Uno', currentPassword: STAFF_PASSWORD } })).json();
    const second = (await createRequest(ctx, { json: { name: 'Dos', currentPassword: STAFF_PASSWORD } })).json();
    const revoked = (await createRequest(ctx, { json: { name: 'Revocado', currentPassword: STAFF_PASSWORD } })).json();
    const expired = (await createRequest(ctx, { json: { name: 'Vencido', currentPassword: STAFF_PASSWORD } })).json();
    await createToken(ctx, ctx.users.otherDev, 'clave-de-luis', 'De Luis');
    await send(ctx.app, { method: 'DELETE', url: `/account/api-tokens/${revoked.item.id}`, cookie: ctx.cookies.dev });
    ctx.apiTokenRepository.records.find((record) => record.id === expired.item.id).expiresAt = new Date(Date.now() - 1000);
    // Mismo createdAt: el desempate por id deja primero al más nuevo.
    for (const record of ctx.apiTokenRepository.records) {
      record.createdAt = new Date(record.id === second.item.id ? Date.now() : Date.now() - 60000);
    }

    const response = await send(ctx.app, { url: '/account/api-tokens', cookie: ctx.cookies.dev });

    expect(response.statusCode).toBe(200);
    const { items } = response.json();
    expect(items.map((item) => item.name)).toEqual(['Dos', 'Uno']);
    expect(items.map((item) => item.id)).toEqual([second.item.id, first.item.id]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'prefix']);
    }
    expect(response.body).not.toContain('tokenHash');
    expect(response.body).not.toContain(first.token);
  });

  it('revokes an own token with 204 and no body; the token stops working', async () => {
    const created = (await createRequest(ctx)).json();

    const response = await send(ctx.app, { method: 'DELETE', url: `/account/api-tokens/${created.item.id}`, cookie: ctx.cookies.dev });
    const use = await send(ctx.app, { url: '/staff/tickets/by-code/ACME-0001', bearer: created.token });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(use.statusCode).toBe(401);
    expect(use.json().error).toBe('invalid_token');
  });

  it.each([
    ['of another user', 'other'],
    ['that does not exist', 'missing'],
    ['already revoked', 'revoked'],
    ['with an invalid id', 'invalid'],
  ])('answers 404 not_found for a token %s', async (_label, kind) => {
    const created = (await createRequest(ctx)).json();
    await createToken(ctx, ctx.users.otherDev, 'clave-de-luis', 'De Luis');
    const othersId = ctx.apiTokenRepository.records.find((record) => record.userId === ctx.users.otherDev.id).id;
    if (kind === 'revoked') {
      await send(ctx.app, { method: 'DELETE', url: `/account/api-tokens/${created.item.id}`, cookie: ctx.cookies.dev });
    }
    const id = { other: othersId, missing: 'ffffffffffffffffffffffff', revoked: created.item.id, invalid: 'no-es-un-id' }[kind];

    const response = await send(ctx.app, { method: 'DELETE', url: `/account/api-tokens/${id}`, cookie: ctx.cookies.dev });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it.each([
    ['GET', '/account/api-tokens'],
    ['POST', '/account/api-tokens'],
    ['DELETE', '/account/api-tokens/ffffffffffffffffffffffff'],
  ])('answers 403 forbidden to a client account on %s %s and 401 without a cookie', async (method, url) => {
    const asClient = await send(ctx.app, { method, url, cookie: ctx.cookies.client, json: method === 'POST' ? {} : undefined });
    const anonymous = await send(ctx.app, { method, url, json: method === 'POST' ? {} : undefined });

    expect(asClient.statusCode).toBe(403);
    expect(asClient.json()).toEqual({ error: 'forbidden' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ error: 'unauthorized' });
  });

  it.each([
    ['GET', '/account/api-tokens'],
    ['POST', '/account/api-tokens'],
    ['DELETE', '/account/api-tokens/ffffffffffffffffffffffff'],
  ])('a valid Bearer without cookie on %s %s answers 401 unauthorized without looking the token up', async (method, url) => {
    const token = await createToken(ctx);
    const findByHash = jest.spyOn(ctx.apiTokenRepository, 'findByHash');

    const response = await send(ctx.app, {
      method,
      url,
      bearer: token,
      json: method === 'POST' ? { name: 'Otro', currentPassword: STAFF_PASSWORD } : undefined,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(findByHash).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/account/api-tokens'],
    ['DELETE', '/account/api-tokens/ffffffffffffffffffffffff'],
  ])('%s %s with a cookie and without X-Panel-Request answers 403 missing_panel_header', async (method, url) => {
    const response = await send(ctx.app, {
      method,
      url,
      cookie: ctx.cookies.dev,
      panelHeader: false,
      json: method === 'POST' ? { name: 'Laptop', currentPassword: STAFF_PASSWORD } : undefined,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'missing_panel_header' });
    expect(ctx.apiTokenRepository.records).toHaveLength(0);
  });

  it('changing the own password keeps the tokens', async () => {
    const token = await createToken(ctx);

    const change = await send(ctx.app, {
      method: 'POST',
      url: '/auth/change-password',
      cookie: ctx.cookies.dev,
      json: { currentPassword: STAFF_PASSWORD, newPassword: 'NuevaClave2026!' },
    });
    const use = await send(ctx.app, { url: '/staff/tickets/by-code/ACME-0001', bearer: token });

    expect(change.statusCode).toBe(204);
    expect(use.statusCode).toBe(404);
    expect(ctx.apiTokenRepository.records[0].revokedAt).toBeNull();
  });

  it('deactivating the user through the admin API revokes the tokens; reactivating does not revive them', async () => {
    const token = await createToken(ctx);
    const before = await send(ctx.app, { url: '/staff/tickets/by-code/ACME-0001', bearer: token });

    const deactivate = await send(ctx.app, {
      method: 'PATCH',
      url: `/staff/users/${ctx.users.dev.id}`,
      cookie: ctx.cookies.admin,
      json: { active: false },
    });
    const reactivate = await send(ctx.app, {
      method: 'PATCH',
      url: `/staff/users/${ctx.users.dev.id}`,
      cookie: ctx.cookies.admin,
      json: { active: true },
    });
    const after = await send(ctx.app, { url: '/staff/tickets/by-code/ACME-0001', bearer: token });

    expect(before.statusCode).toBe(404);
    expect(deactivate.statusCode).toBe(200);
    expect(reactivate.statusCode).toBe(200);
    expect(ctx.apiTokenRepository.records[0]).toMatchObject({ revokedReason: 'user_deactivated' });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe('invalid_token');
  });

  it('resetting the password through the admin API revokes the tokens', async () => {
    const token = await createToken(ctx);

    const reset = await send(ctx.app, {
      method: 'POST',
      url: `/staff/users/${ctx.users.dev.id}/reset-password`,
      cookie: ctx.cookies.admin,
    });
    const after = await send(ctx.app, { url: '/staff/tickets/by-code/ACME-0001', bearer: token });

    expect(reset.statusCode).toBe(200);
    expect(ctx.apiTokenRepository.records[0]).toMatchObject({ revokedReason: 'password_reset' });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe('invalid_token');
  });

  it('a failing revocation on reset still returns the temporary password and logs the error', async () => {
    await createToken(ctx);
    ctx.apiTokenRepository.failNextRevokeAll = true;

    const reset = await send(ctx.app, {
      method: 'POST',
      url: `/staff/users/${ctx.users.dev.id}/reset-password`,
      cookie: ctx.cookies.admin,
    });

    expect(reset.statusCode).toBe(200);
    expect(reset.json().temporaryPassword).toEqual(expect.any(String));
    expect(ctx.logger.error).toHaveBeenCalledWith({ msg: 'Panel API tokens: revoke on password reset failed', userId: ctx.users.dev.id });
  });
});
