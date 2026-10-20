import { jest } from '@jest/globals';
import Fastify from 'fastify';
import panelPlugin from '../../../src/interfaces/http/panel/panelPlugin.js';
import { buildPanelUseCases } from '../../../src/composition/panel.composition.js';
import HmacSessionToken from '../../../src/infrastructure/auth/HmacSessionToken.js';
import {
  FakeLoginAttempts,
  FakePasswordHasher,
  FakeTenantDirectory,
  InMemoryPanelUserRepository,
  FakeRevokedSessions,
  RecordingAuditLog,
  SequenceTemporaryPassword,
  TENANTS,
  clientUser,
  staffUser,
} from '../application/panel/panelFakes.js';

const SECRET = 'panel-api-test-secret-with-32-chars-min';
const PANEL = { 'x-panel-request': '1' };

async function buildApp({
  users = [],
  useCasesOverride,
  secret = SECRET,
  passwordHasher = new FakePasswordHasher(),
  ipLoginAttempts = null,
  trustedProxies = [],
} = {}) {
  const userRepository = new InMemoryPanelUserRepository(users);
  const auditLog = new RecordingAuditLog();
  const revokedSessions = new FakeRevokedSessions();
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const useCases = useCasesOverride ?? buildPanelUseCases({
    secret,
    userRepository,
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    passwordHasher,
    temporaryPasswordGenerator: new SequenceTemporaryPassword(),
    loginAttempts: new FakeLoginAttempts(),
    ipLoginAttempts,
    auditLog,
    revokedSessions,
    sessionToken: new HmacSessionToken({ secret }),
  });

  const app = Fastify();
  // Igual que src/main/app.js: parser JSON propio en la raíz, para probar que el del panel lo reemplaza solo adentro.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      done(error, undefined);
    }
  });
  app.get('/outside', async () => ({ ok: true }));
  app.post('/outside', async (req) => ({ body: req.body }));
  app.register(panelPlugin, { prefix: '/panel/api', secret, useCases, logger, trustedProxies });
  await app.ready();

  return { app, userRepository, logger, useCases, auditLog, revokedSessions };
}

function sessionCookie(response) {
  const cookie = response.cookies.find((candidate) => candidate.name === 'panel_session');
  return cookie ? `panel_session=${cookie.value}` : null;
}

async function login(app, email, password) {
  const response = await app.inject({
    method: 'POST',
    url: '/panel/api/auth/login',
    headers: PANEL,
    payload: { email, password },
  });
  return { response, cookie: sessionCookie(response) };
}

describe('/panel/api — login and session cookie', () => {
  let ctx;
  const staff = staffUser();
  const inactive = clientUser({ email: 'baja@acme.test', active: false });

  beforeEach(async () => {
    ctx = await buildApp({ users: [staff, inactive] });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('sets the session cookie with its attributes and returns the /me body (C4)', async () => {
    const { response } = await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ accountType: 'smarteam', mustChangePassword: false }));
    const [setCookie] = [].concat(response.headers['set-cookie']);
    expect(setCookie).toMatch(/^panel_session=[^;]+;/);
    expect(setCookie).toContain('Max-Age=28800');
    expect(setCookie).toContain('Path=/api');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['unknown email', 'nadie@acme.test', 'clave-del-staff'],
    ['deactivated user', 'baja@acme.test', 'clave-del-cliente'],
    ['wrong password', 'dev@smarteam.test', 'mala-clave'],
  ])('answers 401 invalid_credentials for %s', async (_label, email, password) => {
    const { response } = await login(ctx.app, email, password);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_credentials' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('answers 429 too_many_attempts on the sixth attempt', async () => {
    for (let index = 0; index < 5; index += 1) {
      await login(ctx.app, 'dev@smarteam.test', 'mala-clave');
    }

    const { response } = await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff');

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe('too_many_attempts');
  });

  it('answers 400 validation_error for a missing password', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/login',
      headers: PANEL,
      payload: { email: 'dev@smarteam.test' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message: 'Correo y contraseña son obligatorios.' });
  });

  it('requires X-Panel-Request on the login too', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/login',
      payload: { email: 'dev@smarteam.test', password: 'clave-del-staff' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'missing_panel_header' });
  });

  it('never exposes password data in the login body', async () => {
    const { response } = await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff');

    expect(response.body).not.toMatch(/passwordHash|tokenVersion|clave-del-staff/);
  });
});

describe('/panel/api — session and pending password change', () => {
  let ctx;
  const temporary = staffUser({ email: 'nuevo@smarteam.test', passwordHash: 'hash:Temporal000009', mustChangePassword: true });

  beforeEach(async () => {
    ctx = await buildApp({ users: [temporary] });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('answers 401 without a cookie and with a forged cookie', async () => {
    const missing = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me' });
    const forged = await ctx.app.inject({
      method: 'GET',
      url: '/panel/api/auth/me',
      headers: { cookie: `panel_session=${new HmacSessionToken({ secret: 'otro' }).sign({ sub: temporary.id, tv: 0 })}` },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: 'unauthorized' });
    expect(forged.statusCode).toBe(401);
    expect([].concat(forged.headers['set-cookie'])[0]).toMatch(/^panel_session=;/);
  });

  it('lets /auth/me answer 200 with mustChangePassword while blocking the rest (C1)', async () => {
    const { cookie } = await login(ctx.app, 'nuevo@smarteam.test', 'Temporal000009');

    const me = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie } });
    const users = await ctx.app.inject({ method: 'GET', url: '/panel/api/staff/users', headers: { cookie } });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(expect.objectContaining({ name: 'Dev Smarteam', mustChangePassword: true }));
    expect(users.statusCode).toBe(403);
    expect(users.json()).toEqual({ error: 'password_change_required' });
  });

  it('changes the password with 204 and a new cookie that works; the old one stops working (C3)', async () => {
    const { cookie: oldCookie } = await login(ctx.app, 'nuevo@smarteam.test', 'Temporal000009');

    const change = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/change-password',
      headers: { ...PANEL, cookie: oldCookie },
      payload: { currentPassword: 'Temporal000009', newPassword: 'mi-clave-nueva-larga' },
    });
    const newCookie = sessionCookie(change);

    expect(change.statusCode).toBe(204);
    expect(newCookie).not.toBeNull();
    expect(newCookie).not.toBe(oldCookie);

    const withNew = await ctx.app.inject({ method: 'GET', url: '/panel/api/staff/users', headers: { cookie: newCookie } });
    const withOld = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: oldCookie } });

    expect(withNew.statusCode).toBe(200);
    expect(withOld.statusCode).toBe(401);
  });

  it('answers 400 invalid_current_password, never 401, for a wrong current password (C2)', async () => {
    const { cookie } = await login(ctx.app, 'nuevo@smarteam.test', 'Temporal000009');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/change-password',
      headers: { ...PANEL, cookie },
      payload: { currentPassword: 'equivocada', newPassword: 'mi-clave-nueva-larga' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_current_password');
  });

  it.each([
    ['corta', 'Debe tener al menos 10 caracteres.'],
    ['Temporal000009', 'La contraseña nueva debe ser distinta de la actual.'],
    ['a'.repeat(201), 'Debe tener como máximo 200 caracteres.'],
  ])('answers 400 validation_error with a readable message for %s', async (newPassword, message) => {
    const { cookie } = await login(ctx.app, 'nuevo@smarteam.test', 'Temporal000009');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/change-password',
      headers: { ...PANEL, cookie },
      payload: { currentPassword: 'Temporal000009', newPassword },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message });
  });

  it.each([
    ['with a valid session', true],
    ['without a session', false],
  ])('logs out %s with 204 and clears the cookie, even with an empty JSON body', async (_label, withSession) => {
    const headers = { ...PANEL, 'content-type': 'application/json' };
    if (withSession) {
      headers.cookie = (await login(ctx.app, 'nuevo@smarteam.test', 'Temporal000009')).cookie;
    }

    const response = await ctx.app.inject({ method: 'POST', url: '/panel/api/auth/logout', headers, payload: '' });

    expect(response.statusCode).toBe(204);
    const [setCookie] = [].concat(response.headers['set-cookie']);
    expect(setCookie).toMatch(/^panel_session=;/);
    expect(setCookie).toContain('Path=/api');
  });
});

describe('/panel/api — staff users (C6–C9)', () => {
  let ctx;
  let staffCookie;
  const staff = staffUser();
  const client = clientUser({ createdAt: new Date('2026-08-01T15:00:00.000Z') });

  beforeEach(async () => {
    ctx = await buildApp({ users: [staff, client] });
    staffCookie = (await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff')).cookie;
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  function asStaff(method, url, payload) {
    return ctx.app.inject({
      method,
      url: `/panel/api${url}`,
      headers: method === 'GET' ? { cookie: staffCookie } : { ...PANEL, cookie: staffCookie },
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  it('lists users with pagination and without password fields (C6, C8)', async () => {
    const response = await asStaff('GET', '/staff/users?page=1&pageSize=10');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual(expect.objectContaining({ page: 1, pageSize: 10, total: 2 }));
    expect(body.items[0].id).toBe(staff.id);
    expect(response.body).not.toMatch(/passwordHash|tokenVersion/);
  });

  it('answers 400 for pageSize over 100', async () => {
    const response = await asStaff('GET', '/staff/users?pageSize=101');

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('creates a user with 201 and returns the temporary password once', async () => {
    const response = await asStaff('POST', '/staff/users', {
      email: 'mario@acme.test',
      name: 'Mario Quesada',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      role: 'usuario',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user: expect.objectContaining({ email: 'mario@acme.test', companyName: 'Acme Industrial', mustChangePassword: true }),
      temporaryPassword: 'Temporal000001',
    });

    const list = await asStaff('GET', '/staff/users');
    expect(list.body).not.toContain('Temporal000001');
  });

  it('answers 409 email_taken for a duplicated email', async () => {
    const response = await asStaff('POST', '/staff/users', {
      email: 'admin@acme.test',
      name: 'Otra',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      role: 'admin',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'email_taken', message: 'Ya existe un usuario con ese correo.' });
  });

  it('answers 400 for an unknown tenant on create', async () => {
    const response = await asStaff('POST', '/staff/users', {
      email: 'nuevo@nadie.test',
      name: 'Nuevo',
      accountType: 'cliente',
      tenantKey: 'sap_integration_nadie',
      role: 'admin',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message: 'La empresa no existe.' });
  });

  it('rejects tenantKey or accountType in a PATCH', async () => {
    const response = await asStaff('PATCH', `/staff/users/${client.id}`, { tenantKey: 'sap_integration_initech' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('refuses self deactivation and self reset (C9, C9-a)', async () => {
    const deactivate = await asStaff('PATCH', `/staff/users/${staff.id}`, { active: false });
    const reset = await asStaff('POST', `/staff/users/${staff.id}/reset-password`);

    expect(deactivate.statusCode).toBe(400);
    expect(deactivate.json()).toEqual({ error: 'validation_error', message: 'No puedes desactivar tu propia cuenta.' });
    expect(reset.statusCode).toBe(400);
    expect(reset.json().message).toBe('No puedes restablecer tu propia contraseña desde aquí.');
  });

  it('answers 404 not_found for unknown or malformed ids', async () => {
    const unknown = await asStaff('PATCH', '/staff/users/ffffffffffffffffffffffff', { name: 'x' });
    const malformed = await asStaff('POST', '/staff/users/no-es-un-id/reset-password');

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });
    expect(malformed.statusCode).toBe(404);
  });

  it('cuts the open session of a user that is reset or deactivated', async () => {
    const clientCookie = (await login(ctx.app, 'admin@acme.test', 'clave-del-cliente')).cookie;
    const before = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: clientCookie } });

    const reset = await asStaff('POST', `/staff/users/${client.id}/reset-password`);
    const after = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: clientCookie } });

    expect(before.statusCode).toBe(200);
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ temporaryPassword: 'Temporal000001' });
    expect(after.statusCode).toBe(401);

    const relogin = (await login(ctx.app, 'admin@acme.test', 'Temporal000001')).cookie;
    await asStaff('PATCH', `/staff/users/${client.id}`, { active: false });
    const deactivated = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: relogin } });
    expect(deactivated.statusCode).toBe(401);
  });

  it('applies a role change on the next request', async () => {
    const usuario = await asStaff('POST', '/staff/users', {
      email: 'vendedor@acme.test',
      name: 'Vendedor',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      role: 'usuario',
    });
    const { id } = usuario.json().user;
    const { temporaryPassword } = usuario.json();
    const cookie = (await login(ctx.app, 'vendedor@acme.test', temporaryPassword)).cookie;

    await asStaff('PATCH', `/staff/users/${id}`, { role: 'admin' });
    const me = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie } });

    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('admin');
  });

  it('lists tenants without pagination, suspended included (C7)', async () => {
    const response = await asStaff('GET', '/staff/tenants');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: TENANTS });
  });
});

describe('/panel/api — permissions', () => {
  let ctx;
  let clientCookie;

  beforeEach(async () => {
    ctx = await buildApp({ users: [clientUser()] });
    clientCookie = (await login(ctx.app, 'admin@acme.test', 'clave-del-cliente')).cookie;
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it.each([
    ['GET', '/staff/users'],
    ['POST', '/staff/users'],
    ['PATCH', '/staff/users/ffffffffffffffffffffffff'],
    ['POST', '/staff/users/ffffffffffffffffffffffff/reset-password'],
    ['GET', '/staff/tenants'],
  ])('answers 403 forbidden to a cliente account on %s %s', async (method, url) => {
    const response = await ctx.app.inject({
      method,
      url: `/panel/api${url}`,
      headers: method === 'GET' ? { cookie: clientCookie } : { ...PANEL, cookie: clientCookie },
      ...(method === 'GET' ? {} : { payload: {} }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });
  });
});

describe('/panel/api — parser, errors and isolation', () => {
  let ctx;
  let staffCookie;

  beforeEach(async () => {
    ctx = await buildApp({ users: [staffUser()] });
    staffCookie = (await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff')).cookie;
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('answers 400 validation_error for malformed JSON', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/login',
      headers: { ...PANEL, 'content-type': 'application/json' },
      payload: '{"email": ',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message: 'La solicitud no es válida.' });
  });

  it('rejects prototype pollution in the body', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/staff/users',
      headers: { ...PANEL, cookie: staffCookie, 'content-type': 'application/json' },
      payload: '{"__proto__": {"admin": true}, "email": "x@y.test"}',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('answers 401 for an unknown route without session and 404 not_found with session (R2)', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/panel/api/no-existe' });
    const authenticated = await ctx.app.inject({ method: 'GET', url: '/panel/api/no-existe', headers: { cookie: staffCookie } });

    expect(anonymous.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(404);
    expect(authenticated.json()).toEqual({ error: 'not_found' });
  });

  it('answers 500 internal_error for an unexpected failure and logs without headers or body', async () => {
    ctx.useCases.listTenants.execute = async () => {
      throw new Error('boom');
    };

    const response = await ctx.app.inject({ method: 'GET', url: '/panel/api/staff/tenants', headers: { cookie: staffCookie } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal_error' });
    const logged = JSON.stringify(ctx.logger.error.mock.calls);
    expect(logged).toContain('boom');
    expect(logged).not.toContain('panel_session');
  });

  it('never answers with ok:false nor with field names that mention concrete systems', async () => {
    const responses = await Promise.all([
      ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: staffCookie } }),
      ctx.app.inject({ method: 'GET', url: '/panel/api/staff/users', headers: { cookie: staffCookie } }),
      ctx.app.inject({ method: 'GET', url: '/panel/api/staff/tenants', headers: { cookie: staffCookie } }),
      ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me' }),
    ]);

    const fieldNames = (value) => {
      if (Array.isArray(value)) return value.flatMap(fieldNames);
      if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => [key, ...fieldNames(child)]);
      return [];
    };

    responses.forEach((response) => {
      expect(response.body).not.toContain('"ok":false');
      expect(response.headers['cache-control']).toBe('no-store');
      fieldNames(response.json()).forEach((key) => expect(key).not.toMatch(/sap|hubspot/i));
    });
  });

  it('does not ask for a session when x-internal-key is the only credential', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/panel/api/staff/users',
      headers: { 'x-internal-key': 'cualquier-llave' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('leaves routes outside the prefix untouched (parser, cookie header, cache header)', async () => {
    const get = await ctx.app.inject({ method: 'GET', url: '/outside' });
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/outside',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });

    expect(get.statusCode).toBe(200);
    expect(get.headers['cache-control']).toBeUndefined();
    expect(post.json()).toEqual({ body: { a: 1 } });
  });
});

describe('/panel/api — logout revokes only this session', () => {
  it('cuts the session that logs out and keeps the other one', async () => {
    const ctx = await buildApp({ users: [staffUser()] });
    const first = (await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff')).cookie;
    const second = (await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff')).cookie;

    const logout = await ctx.app.inject({ method: 'POST', url: '/panel/api/auth/logout', headers: { ...PANEL, cookie: first } });
    const replayed = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: first } });
    const other = await ctx.app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: second } });

    expect(logout.statusCode).toBe(204);
    expect(replayed.statusCode).toBe(401);
    expect(other.statusCode).toBe(200);
    expect(ctx.revokedSessions.revoked.size).toBe(1);
    expect(ctx.auditLog.actions()).toContain('auth.logout');
    await ctx.app.close();
  });

  it('answers 204 and logs an error without the token when the revocation fails', async () => {
    const ctx = await buildApp({ users: [staffUser()] });
    ctx.revokedSessions.revoke = async () => { throw new Error('master down'); };
    const { cookie } = await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff');

    const response = await ctx.app.inject({ method: 'POST', url: '/panel/api/auth/logout', headers: { ...PANEL, cookie } });

    expect(response.statusCode).toBe(204);
    expect([].concat(response.headers['set-cookie'])[0]).toMatch(/^panel_session=;/);
    expect(ctx.logger.error).toHaveBeenCalledWith({ msg: 'Panel logout: session revocation failed', error: 'master down' });
    expect(JSON.stringify(ctx.logger.error.mock.calls)).not.toContain(cookie.split('=')[1]);
    await ctx.app.close();
  });

  it('issues a new session id when the password changes', async () => {
    const temporary = staffUser({ passwordHash: 'hash:Temporal000009', mustChangePassword: true });
    const ctx = await buildApp({ users: [temporary] });
    const { cookie } = await login(ctx.app, 'dev@smarteam.test', 'Temporal000009');
    const sidOf = (value) => JSON.parse(Buffer.from(value.split('=')[1].split('.')[1], 'base64url').toString()).sid;

    const change = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/change-password',
      headers: { ...PANEL, cookie },
      payload: { currentPassword: 'Temporal000009', newPassword: 'mi-clave-nueva-larga' },
    });

    expect(sidOf(sessionCookie(change))).not.toBe(sidOf(cookie));
    await ctx.app.close();
  });
});

describe('/panel/api — audit trail through HTTP', () => {
  it('records who created a user and from which IP, without the temporary password', async () => {
    const staff = staffUser();
    const ctx = await buildApp({ users: [staff] });
    const { cookie } = await login(ctx.app, 'dev@smarteam.test', 'clave-del-staff');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/staff/users',
      headers: { ...PANEL, cookie },
      payload: { email: 'nuevo@smarteam.test', name: 'Nuevo', accountType: 'smarteam' },
    });

    const entry = ctx.auditLog.entries.find((candidate) => candidate.action === 'user.created');
    expect(entry).toEqual(expect.objectContaining({
      actor: { userId: staff.id, email: 'dev@smarteam.test', accountType: 'smarteam' },
      ip: '127.0.0.1',
    }));
    expect(JSON.stringify(ctx.auditLog.entries)).not.toContain(created.json().temporaryPassword);
    await ctx.app.close();
  });
});

describe('/panel/api — per-IP login limit', () => {
  function loginFrom(app, ip, email = 'nadie@acme.test') {
    return app.inject({
      method: 'POST',
      url: '/panel/api/auth/login',
      headers: { ...PANEL, 'x-forwarded-for': ip },
      payload: { email, password: 'mala-clave' },
    });
  }

  it('counts each client IP separately behind a trusted proxy', async () => {
    const ctx = await buildApp({ ipLoginAttempts: new FakeLoginAttempts(2), trustedProxies: ['127.0.0.1'] });

    await loginFrom(ctx.app, '203.0.113.7', 'a@acme.test');
    await loginFrom(ctx.app, '203.0.113.7', 'b@acme.test');
    const blocked = await loginFrom(ctx.app, '203.0.113.7', 'c@acme.test');
    const otherIp = await loginFrom(ctx.app, '198.51.100.1', 'c@acme.test');

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('too_many_attempts');
    expect(otherIp.statusCode).toBe(401);
    await ctx.app.close();
  });

  it('warns and does not limit by IP without trusted proxies', async () => {
    const ctx = await buildApp({ ipLoginAttempts: null, trustedProxies: [] });

    for (let index = 0; index < 4; index += 1) {
      const response = await loginFrom(ctx.app, '203.0.113.7', `u${index}@acme.test`);
      expect(response.statusCode).toBe(401);
    }
    expect(ctx.logger.warn).toHaveBeenCalledWith({
      msg: 'Panel API: per-IP login limit disabled (PANEL_TRUSTED_PROXIES not set)',
    });
    await ctx.app.close();
  });

  it('ignores a spoofed X-Forwarded-For when the socket is not a trusted proxy', async () => {
    const ctx = await buildApp({ ipLoginAttempts: new FakeLoginAttempts(1), trustedProxies: ['10.9.9.9'] });

    await loginFrom(ctx.app, '1.1.1.1', 'a@acme.test');
    const second = await loginFrom(ctx.app, '2.2.2.2', 'b@acme.test');

    // Sin proxy de confianza, la IP es la del socket (127.0.0.1) para las dos: el header no la cambia.
    expect(second.statusCode).toBe(429);
    await ctx.app.close();
  });
});

describe('/panel/api — saturated password hasher', () => {
  it('answers 429 with Retry-After and leaves the rest of the API alone', async () => {
    const { PanelHasherBusyError } = await import('../../../src/domain/panel/errors.js');
    const busyHasher = new FakePasswordHasher();
    busyHasher.verify = async () => { throw new PanelHasherBusyError(); };
    const ctx = await buildApp({ users: [staffUser()], passwordHasher: busyHasher });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/panel/api/auth/login',
      headers: PANEL,
      payload: { email: 'dev@smarteam.test', password: 'clave-del-staff' },
    });
    const outside = await ctx.app.inject({ method: 'GET', url: '/outside' });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.json()).toEqual({
      error: 'too_many_attempts',
      message: 'Hay demasiados intentos en este momento. Intenta de nuevo en unos segundos.',
    });
    expect(outside.statusCode).toBe(200);
    expect(ctx.logger.error).not.toHaveBeenCalled();
    await ctx.app.close();
  });
});

describe('/panel/api — fail closed', () => {
  it.each([
    ['missing', { secret: null }, 'Panel API disabled: PANEL_JWT_SECRET not set'],
    ['too short', { secret: 'corto' }, 'Panel API disabled: PANEL_JWT_SECRET must have at least 32 characters'],
    [
      'equal to JWT_SECRET',
      { secret: 'x'.repeat(40), tenantJwtSecret: 'x'.repeat(40) },
      'Panel API disabled: PANEL_JWT_SECRET must differ from JWT_SECRET',
    ],
  ])('registers nothing and warns when the secret is %s', async (_label, options, message) => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const app = Fastify();
    app.register(panelPlugin, { prefix: '/panel/api', logger, ...options });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/panel/api/auth/me' });

    expect(response.statusCode).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith({ msg: message });
    await app.close();
  });
});
