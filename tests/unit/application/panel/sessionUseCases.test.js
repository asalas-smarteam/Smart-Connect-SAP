import LoginPanelUser from '../../../../src/application/use-cases/panel/LoginPanelUser.js';
import ResolvePanelSession from '../../../../src/application/use-cases/panel/ResolvePanelSession.js';
import GetPanelSession from '../../../../src/application/use-cases/panel/GetPanelSession.js';
import ChangePanelPassword from '../../../../src/application/use-cases/panel/ChangePanelPassword.js';
import ListPanelTenants from '../../../../src/application/use-cases/panel/ListPanelTenants.js';
import { panelReasons } from '../../../../src/application/use-cases/panel/panelReasons.js';
import {
  FakeLoginAttempts,
  FakePasswordHasher,
  FakeSessionToken,
  FakeTenantDirectory,
  InMemoryPanelUserRepository,
  TENANTS,
  clientUser,
  staffUser,
} from './panelFakes.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');

function setup(users) {
  const userRepository = new InMemoryPanelUserRepository(users);
  const tenantDirectory = new FakeTenantDirectory(TENANTS);
  const passwordHasher = new FakePasswordHasher();
  const sessionToken = new FakeSessionToken();
  const loginAttempts = new FakeLoginAttempts();

  return {
    userRepository,
    passwordHasher,
    loginAttempts,
    sessionToken,
    login: new LoginPanelUser({
      userRepository,
      tenantDirectory,
      passwordHasher,
      sessionToken,
      loginAttempts,
      now: () => NOW,
    }),
    resolve: new ResolvePanelSession({ userRepository, sessionToken }),
    me: new GetPanelSession({ userRepository, tenantDirectory }),
    changePassword: new ChangePanelPassword({ userRepository, passwordHasher, sessionToken }),
    tenants: new ListPanelTenants({ tenantDirectory }),
  };
}

describe('LoginPanelUser', () => {
  it('logs in, resets the counter, records the login and returns the session body (C4)', async () => {
    const client = clientUser({ mustChangePassword: true, tokenVersion: 4 });
    const ctx = setup([client]);
    await ctx.loginAttempts.consume('admin@acme.test');

    const result = await ctx.login.execute({ email: ' Admin@Acme.TEST ', password: 'clave-del-cliente' });

    expect(result.ok).toBe(true);
    expect(ctx.sessionToken.verify(result.data.token)).toEqual(expect.objectContaining({ sub: client.id, tv: 4, pwdChange: true }));
    expect(result.data.session).toEqual({
      name: 'Adriana Solís',
      email: 'admin@acme.test',
      accountType: 'cliente',
      role: 'admin',
      tenantKey: 'sap_integration_acme',
      companyName: 'Acme Industrial',
      permissions: ['tickets.read', 'tickets.create', 'tickets.reply', 'tickets.reopen', 'events.read', 'syncs.read', 'mappings.read', 'tasks.read'],
      mustChangePassword: true,
    });
    expect(ctx.loginAttempts.failures.size).toBe(0);
    expect(ctx.userRepository.lastLogins).toEqual([{ id: client.id, date: NOW }]);
  });

  it('returns null company, role and tenant for smarteam accounts', async () => {
    const ctx = setup([staffUser()]);

    const result = await ctx.login.execute({ email: 'dev@smarteam.test', password: 'clave-del-staff' });

    expect(result.data.session).toEqual(expect.objectContaining({
      accountType: 'smarteam',
      role: null,
      tenantKey: null,
      companyName: null,
    }));
  });

  it.each([
    ['an unknown email', 'nadie@acme.test', 'clave-del-cliente', {}],
    ['an inactive user', 'admin@acme.test', 'clave-del-cliente', { active: false }],
    ['a wrong password', 'admin@acme.test', 'otra-clave', {}],
  ])('answers the same invalid_credentials for %s', async (_label, email, password, overrides) => {
    const ctx = setup([clientUser(overrides)]);

    const result = await ctx.login.execute({ email, password });

    expect(result).toEqual({ ok: false, reason: panelReasons.INVALID_CREDENTIALS });
    expect(ctx.loginAttempts.failures.get(email)).toBe(1);
  });

  it('spends a dummy hash comparison when the user does not exist', async () => {
    const ctx = setup([]);

    await ctx.login.execute({ email: 'nadie@acme.test', password: 'x' });

    expect(ctx.passwordHasher.dummyCalls).toBe(1);
  });

  it('blocks the sixth attempt even with the right password', async () => {
    const ctx = setup([clientUser()]);
    for (let index = 0; index < 5; index += 1) {
      await ctx.login.execute({ email: 'admin@acme.test', password: 'mala' });
    }

    const result = await ctx.login.execute({ email: 'admin@acme.test', password: 'clave-del-cliente' });

    expect(result.reason).toBe(panelReasons.TOO_MANY_ATTEMPTS);
    expect(result.message).toMatch(/15 minutos/);
  });

  it.each([
    [{}],
    [{ email: 'admin@acme.test' }],
    [{ password: 'x' }],
    [{ email: 'admin@acme.test', password: 123 }],
  ])('rejects a malformed body %o', async (body) => {
    const ctx = setup([clientUser()]);

    const result = await ctx.login.execute(body);

    expect(result.reason).toBe(panelReasons.VALIDATION_ERROR);
    expect(result.message).toBe('Correo y contraseña son obligatorios.');
  });
});

describe('LoginPanelUser — per-IP limit', () => {
  function setupWithIp(users, ipMax = 30) {
    const ctx = setup(users);
    const ipLoginAttempts = new FakeLoginAttempts(ipMax);
    const login = new LoginPanelUser({
      userRepository: ctx.userRepository,
      tenantDirectory: new FakeTenantDirectory(TENANTS),
      passwordHasher: ctx.passwordHasher,
      sessionToken: ctx.sessionToken,
      loginAttempts: ctx.loginAttempts,
      ipLoginAttempts,
      now: () => NOW,
    });
    return { ...ctx, login, ipLoginAttempts };
  }

  it('blocks the 31st attempt from the same IP even with different emails', async () => {
    const ctx = setupWithIp([]);
    for (let index = 0; index < 30; index += 1) {
      await ctx.login.execute({ email: `u${index}@acme.test`, password: 'x', clientIp: '203.0.113.7' });
    }

    const result = await ctx.login.execute({ email: 'otro@acme.test', password: 'x', clientIp: '203.0.113.7' });
    const otherIp = await ctx.login.execute({ email: 'otro@acme.test', password: 'x', clientIp: '198.51.100.1' });

    expect(result.reason).toBe(panelReasons.TOO_MANY_ATTEMPTS);
    expect(otherIp.reason).toBe(panelReasons.INVALID_CREDENTIALS);
  });

  it('does not reset the IP counter on a successful login', async () => {
    const ctx = setupWithIp([clientUser()], 2);

    await ctx.login.execute({ email: 'admin@acme.test', password: 'clave-del-cliente', clientIp: '203.0.113.7' });
    await ctx.login.execute({ email: 'admin@acme.test', password: 'clave-del-cliente', clientIp: '203.0.113.7' });
    const third = await ctx.login.execute({ email: 'admin@acme.test', password: 'clave-del-cliente', clientIp: '203.0.113.7' });

    expect(third.reason).toBe(panelReasons.TOO_MANY_ATTEMPTS);
  });

  it('does not touch the email counter nor run scrypt when the IP is blocked', async () => {
    const ctx = setupWithIp([], 0);
    ctx.passwordHasher.verifyDummy = async () => { throw new Error('scrypt should not run'); };

    const result = await ctx.login.execute({ email: 'nadie@acme.test', password: 'x', clientIp: '203.0.113.7' });

    expect(result.reason).toBe(panelReasons.TOO_MANY_ATTEMPTS);
    expect(ctx.loginAttempts.failures.size).toBe(0);
  });

  it('has no IP limit without a client IP or without the IP counter', async () => {
    const ctx = setupWithIp([], 0);
    const withoutIp = await ctx.login.execute({ email: 'nadie@acme.test', password: 'x' });
    const plain = setup([]);
    const withoutCounter = await plain.login.execute({ email: 'nadie@acme.test', password: 'x', clientIp: '203.0.113.7' });

    expect(withoutIp.reason).toBe(panelReasons.INVALID_CREDENTIALS);
    expect(withoutCounter.reason).toBe(panelReasons.INVALID_CREDENTIALS);
  });
});

describe('ResolvePanelSession', () => {
  it('resolves a valid token into the session user with its permissions', async () => {
    const client = clientUser({ mustChangePassword: true });
    const ctx = setup([client]);

    const result = await ctx.resolve.execute({ token: ctx.sessionToken.sign({ sub: client.id, tv: 0 }) });

    expect(result.ok).toBe(true);
    expect(result.data.user).toEqual({
      id: client.id,
      name: client.name,
      email: client.email,
      accountType: 'cliente',
      role: 'admin',
      tenantKey: 'sap_integration_acme',
      permissions: expect.arrayContaining(['tickets.read', 'events.read']),
    });
    expect(result.data.mustChangePassword).toBe(true);
  });

  it('reads mustChangePassword from the user, not from the token', async () => {
    const client = clientUser({ mustChangePassword: true });
    const ctx = setup([client]);

    const result = await ctx.resolve.execute({ token: ctx.sessionToken.sign({ sub: client.id, tv: 0, pwdChange: false }) });

    expect(result.data.mustChangePassword).toBe(true);
  });

  it.each([
    ['no token', () => undefined],
    ['an invalid token', () => 'garbage'],
    ['an unknown user', (ctx) => ctx.sessionToken.sign({ sub: 'ffffffffffffffffffffffff', tv: 0 })],
    ['an old token version', (ctx, user) => ctx.sessionToken.sign({ sub: user.id, tv: 1 })],
  ])('rejects %s', async (_label, buildToken) => {
    const client = clientUser({ tokenVersion: 2 });
    const ctx = setup([client]);

    const result = await ctx.resolve.execute({ token: buildToken(ctx, client) });

    expect(result).toEqual({ ok: false, reason: panelReasons.UNAUTHORIZED });
  });

  it('rejects a deactivated user', async () => {
    const client = clientUser({ active: false });
    const ctx = setup([client]);

    const result = await ctx.resolve.execute({ token: ctx.sessionToken.sign({ sub: client.id, tv: 0 }) });

    expect(result.reason).toBe(panelReasons.UNAUTHORIZED);
  });

  it('picks up a role change on the next resolution', async () => {
    const client = clientUser({ role: 'usuario' });
    const ctx = setup([client]);
    const token = ctx.sessionToken.sign({ sub: client.id, tv: 0 });
    await ctx.userRepository.update(client.id, { accountType: 'smarteam', role: null, tenantKey: null });

    const result = await ctx.resolve.execute({ token });

    expect(result.data.user.permissions).toContain('staff.users');
  });
});

describe('GetPanelSession', () => {
  it('returns the /auth/me body with the company name (C1)', async () => {
    const client = clientUser({ mustChangePassword: true });
    const ctx = setup([client]);

    const result = await ctx.me.execute({ userId: client.id });

    expect(result.data).toEqual(expect.objectContaining({
      companyName: 'Acme Industrial',
      mustChangePassword: true,
    }));
  });

  it('answers unauthorized when the user disappeared', async () => {
    const ctx = setup([]);

    await expect(ctx.me.execute({ userId: 'ffffffffffffffffffffffff' })).resolves.toEqual({
      ok: false,
      reason: panelReasons.UNAUTHORIZED,
    });
  });
});

describe('ChangePanelPassword', () => {
  it('changes the password, clears mustChangePassword, bumps tokenVersion and returns a new token (C3)', async () => {
    const client = clientUser({ passwordHash: 'hash:Temporal000001', mustChangePassword: true, tokenVersion: 1 });
    const ctx = setup([client]);

    const result = await ctx.changePassword.execute({
      userId: client.id,
      currentPassword: 'Temporal000001',
      newPassword: 'mi-clave-nueva-larga',
    });

    expect(result.ok).toBe(true);
    expect(ctx.sessionToken.verify(result.data.token)).toEqual(expect.objectContaining({ sub: client.id, tv: 2, pwdChange: false }));
    const stored = await ctx.userRepository.findById(client.id);
    expect(stored).toEqual(expect.objectContaining({
      passwordHash: 'hash:mi-clave-nueva-larga',
      mustChangePassword: false,
      tokenVersion: 2,
    }));
  });

  it('answers invalid_current_password (400, not 401) for a wrong current password (C2)', async () => {
    const client = clientUser();
    const ctx = setup([client]);

    const result = await ctx.changePassword.execute({
      userId: client.id,
      currentPassword: 'equivocada',
      newPassword: 'mi-clave-nueva-larga',
    });

    expect(result.reason).toBe(panelReasons.INVALID_CURRENT_PASSWORD);
    expect(ctx.loginAttempts.failures.size).toBe(0);
  });

  it.each([
    ['short', 'corta', 'Debe tener al menos 10 caracteres.'],
    ['equal to the current one', 'clave-del-cliente', 'La contraseña nueva debe ser distinta de la actual.'],
    ['too long', 'a'.repeat(201), 'Debe tener como máximo 200 caracteres.'],
  ])('rejects a %s new password with a readable message', async (_label, newPassword, message) => {
    const client = clientUser();
    const ctx = setup([client]);

    const result = await ctx.changePassword.execute({
      userId: client.id,
      currentPassword: 'clave-del-cliente',
      newPassword,
    });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message });
    expect((await ctx.userRepository.findById(client.id)).tokenVersion).toBe(0);
  });
});

describe('ChangePanelPassword race with a staff reset', () => {
  it('does not overwrite a reset that happened after the user was read', async () => {
    const client = clientUser({ passwordHash: 'hash:vieja-clave-larga', tokenVersion: 1 });
    const ctx = setup([client]);
    const originalVerify = ctx.passwordHasher.verify.bind(ctx.passwordHasher);
    ctx.passwordHasher.verify = async (...args) => {
      const result = await originalVerify(...args);
      await ctx.userRepository.incrementTokenVersion(client.id, { passwordHash: 'hash:Temporal-de-reset', mustChangePassword: true });
      return result;
    };

    const result = await ctx.changePassword.execute({
      userId: client.id,
      currentPassword: 'vieja-clave-larga',
      newPassword: 'clave-del-atacante',
    });

    expect(result).toEqual({ ok: false, reason: panelReasons.UNAUTHORIZED });
    expect(await ctx.userRepository.findById(client.id)).toEqual(expect.objectContaining({
      passwordHash: 'hash:Temporal-de-reset',
      mustChangePassword: true,
      tokenVersion: 2,
    }));
  });
});

describe('ListPanelTenants', () => {
  it('lists every tenant, suspended included, sorted by company name (C7)', async () => {
    const ctx = setup([]);

    const result = await ctx.tenants.execute();

    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          { tenantKey: 'sap_integration_acme', companyName: 'Acme Industrial', status: 'active' },
          { tenantKey: 'sap_integration_initech', companyName: 'Initech Servicios', status: 'suspended' },
        ],
      },
    });
  });
});
