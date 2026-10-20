import ManagePanelUsers from '../../../../src/application/use-cases/panel/ManagePanelUsers.js';
import LoginPanelUser from '../../../../src/application/use-cases/panel/LoginPanelUser.js';
import ChangePanelPassword from '../../../../src/application/use-cases/panel/ChangePanelPassword.js';
import { buildAuditEntry } from '../../../../src/application/use-cases/panel/panelAudit.js';
import {
  FakeLoginAttempts,
  FakePasswordHasher,
  FakeSessionToken,
  FakeTenantDirectory,
  InMemoryPanelUserRepository,
  RecordingAuditLog,
  SequenceTemporaryPassword,
  TENANTS,
  clientUser,
  staffUser,
} from './panelFakes.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const IP = '203.0.113.7';
const DAYS_180_MS = 180 * 24 * 60 * 60 * 1000;

function setup(users = []) {
  const userRepository = new InMemoryPanelUserRepository(users);
  const tenantDirectory = new FakeTenantDirectory(TENANTS);
  const passwordHasher = new FakePasswordHasher();
  const sessionToken = new FakeSessionToken();
  const auditLog = new RecordingAuditLog();
  const loginAttempts = new FakeLoginAttempts();
  const ipLoginAttempts = new FakeLoginAttempts(1);

  return {
    userRepository,
    auditLog,
    manage: new ManagePanelUsers({
      userRepository,
      tenantDirectory,
      passwordHasher,
      temporaryPasswordGenerator: new SequenceTemporaryPassword(),
      auditLog,
      now: () => NOW,
    }),
    login: new LoginPanelUser({
      userRepository,
      tenantDirectory,
      passwordHasher,
      sessionToken,
      loginAttempts,
      ipLoginAttempts,
      auditLog,
      now: () => NOW,
    }),
    changePassword: new ChangePanelPassword({ userRepository, passwordHasher, sessionToken, auditLog, now: () => NOW }),
  };
}

const staff = staffUser();
const ACTOR = { id: staff.id, email: staff.email, accountType: 'smarteam' };

describe('audit of user management', () => {
  it('records user.created with actor, target, details and no retention', async () => {
    const ctx = setup([staff]);

    const result = await ctx.manage.create({
      actor: ACTOR,
      ip: IP,
      email: 'mario@acme.test',
      name: 'Mario',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      role: 'usuario',
    });

    expect(ctx.auditLog.entries).toEqual([{
      at: NOW,
      action: 'user.created',
      source: 'panel',
      actor: { userId: staff.id, email: staff.email, accountType: 'smarteam' },
      target: { userId: result.data.user.id, email: 'mario@acme.test', tenantKey: 'sap_integration_acme' },
      details: { accountType: 'cliente', role: 'usuario' },
      ip: IP,
      expiresAt: null,
    }]);
    expect(JSON.stringify(ctx.auditLog.entries)).not.toContain(result.data.temporaryPassword);
  });

  it('records the script as source with no actor', async () => {
    const ctx = setup([]);

    await ctx.manage.create({ actor: null, source: 'script', email: 'primer@smarteam.test', name: 'Primer', accountType: 'smarteam' });

    expect(ctx.auditLog.entries[0]).toEqual(expect.objectContaining({ source: 'script', actor: null, ip: null }));
  });

  it('records only the fields that really changed, and the state change separately', async () => {
    const client = clientUser({ role: 'usuario', name: 'Ana' });
    const ctx = setup([staff, client]);

    await ctx.manage.update({ actor: ACTOR, ip: IP, id: client.id, patch: { name: 'Ana', role: 'admin', active: false } });

    expect(ctx.auditLog.actions()).toEqual(['user.updated', 'user.deactivated']);
    expect(ctx.auditLog.entries[0].details).toEqual({ changes: { role: { from: 'usuario', to: 'admin' } } });

    await ctx.manage.update({ actor: ACTOR, id: client.id, patch: { active: true } });
    await ctx.manage.update({ actor: ACTOR, id: client.id, patch: { role: 'admin' } });

    expect(ctx.auditLog.actions()).toEqual(['user.updated', 'user.deactivated', 'user.reactivated']);
  });

  it('records user.password_reset without the temporary password', async () => {
    const client = clientUser();
    const ctx = setup([staff, client]);

    const result = await ctx.manage.resetPassword({ actor: ACTOR, ip: IP, id: client.id });

    expect(ctx.auditLog.actions()).toEqual(['user.password_reset']);
    expect(JSON.stringify(ctx.auditLog.entries)).not.toContain(result.data.temporaryPassword);
    expect(JSON.stringify(ctx.auditLog.entries)).not.toContain('hash:');
  });

  it('records nothing when the action is rejected', async () => {
    const ctx = setup([staff]);

    await ctx.manage.create({ actor: ACTOR, email: 'no-es-correo', name: 'X', accountType: 'smarteam' });
    await ctx.manage.update({ actor: ACTOR, id: staff.id, patch: { active: false } });
    await ctx.manage.resetPassword({ actor: ACTOR, id: staff.id });

    expect(ctx.auditLog.entries).toEqual([]);
  });

  it('keeps the action result when the audit log fails', async () => {
    const ctx = setup([staff]);
    ctx.manage.auditLog = { record: async () => { throw new Error('master down'); } };

    const result = await ctx.manage.create({ actor: ACTOR, email: 'x@smarteam.test', name: 'X', accountType: 'smarteam' });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(201);
  });
});

describe('audit of access events', () => {
  it('records a successful login with 180-day retention and the client IP', async () => {
    const client = clientUser();
    const ctx = setup([client]);

    await ctx.login.execute({ email: 'admin@acme.test', password: 'clave-del-cliente', clientIp: IP });

    expect(ctx.auditLog.entries).toEqual([expect.objectContaining({
      action: 'auth.login_succeeded',
      actor: null,
      target: { userId: client.id, email: 'admin@acme.test', tenantKey: 'sap_integration_acme' },
      ip: IP,
      expiresAt: new Date(NOW.getTime() + DAYS_180_MS),
    })]);
  });

  it('records failed logins without saying why, and with only the email for unknown accounts', async () => {
    const client = clientUser();
    const ctx = setup([client]);

    await ctx.login.execute({ email: 'nadie@acme.test', password: 'clave-secreta-1', clientIp: '198.51.100.1' });
    await ctx.login.execute({ email: 'admin@acme.test', password: 'clave-secreta-2', clientIp: '198.51.100.2' });

    expect(ctx.auditLog.entries.map((entry) => entry.details)).toEqual([
      { reason: 'invalid_credentials' },
      { reason: 'invalid_credentials' },
    ]);
    expect(ctx.auditLog.entries[0].target).toEqual({ userId: null, email: 'nadie@acme.test', tenantKey: null });
    expect(JSON.stringify(ctx.auditLog.entries)).not.toMatch(/clave-secreta/);
  });

  it('records blocks by IP and by email', async () => {
    const ctx = setup([]);

    await ctx.login.execute({ email: 'a@acme.test', password: 'x', clientIp: IP });
    await ctx.login.execute({ email: 'b@acme.test', password: 'x', clientIp: IP });

    expect(ctx.auditLog.entries.at(-1)).toEqual(expect.objectContaining({
      action: 'auth.login_blocked',
      details: { reason: 'ip' },
      target: { userId: null, email: 'b@acme.test', tenantKey: null },
    }));

    for (let index = 0; index < 6; index += 1) {
      await ctx.login.execute({ email: 'c@acme.test', password: 'x' });
    }
    expect(ctx.auditLog.entries.at(-1).details).toEqual({ reason: 'email' });
  });

  it('records a password change by the user, without the passwords or the token', async () => {
    const client = clientUser({ passwordHash: 'hash:vieja-clave-larga' });
    const ctx = setup([client]);

    const result = await ctx.changePassword.execute({
      userId: client.id,
      currentPassword: 'vieja-clave-larga',
      newPassword: 'nueva-clave-larga',
      ip: IP,
    });

    expect(ctx.auditLog.entries).toEqual([expect.objectContaining({
      action: 'auth.password_changed',
      actor: expect.objectContaining({ userId: client.id }),
      target: expect.objectContaining({ userId: client.id }),
    })]);
    const serialized = JSON.stringify(ctx.auditLog.entries);
    expect(serialized).not.toMatch(/vieja-clave|nueva-clave|hash:/);
    expect(serialized).not.toContain(result.data.token);
  });
});

describe('audit volume and content limits', () => {
  it('audits only the first blocked attempt of the window', async () => {
    const ctx = setup([]);
    for (let index = 0; index < 10; index += 1) {
      await ctx.login.execute({ email: 'c@acme.test', password: 'x' });
    }

    expect(ctx.auditLog.actions().filter((action) => action === 'auth.login_blocked')).toHaveLength(1);
  });

  it('does not store an invalid "email" (it may be a password typed in the wrong field)', async () => {
    const ctx = setup([]);

    await ctx.login.execute({ email: 'MiClaveSecreta123', password: 'x' });

    expect(ctx.auditLog.entries[0].target.email).toBeNull();
    expect(JSON.stringify(ctx.auditLog.entries)).not.toMatch(/miclavesecreta123/i);
  });

  it('uses the /64 key for the IP limit and the full IP for the audit', async () => {
    const ctx = setup([]);

    await ctx.login.execute({ email: 'a@acme.test', password: 'x', clientIp: '2001:db8::1', clientIpKey: '2001:0db8:0000:0000::/64' });
    await ctx.login.execute({ email: 'b@acme.test', password: 'x', clientIp: '2001:db8::2', clientIpKey: '2001:0db8:0000:0000::/64' });

    const blocked = ctx.auditLog.entries.find((entry) => entry.action === 'auth.login_blocked');
    expect(blocked).toEqual(expect.objectContaining({ ip: '2001:db8::2', details: { reason: 'ip' } }));
  });
});

describe('buildAuditEntry', () => {
  it('only keeps the details allowed for the action', () => {
    const entry = buildAuditEntry({
      action: 'user.created',
      details: { accountType: 'cliente', role: 'admin', temporaryPassword: 'Secreto', passwordHash: 'x' },
      at: NOW,
    });

    expect(entry.details).toEqual({ accountType: 'cliente', role: 'admin' });
  });

  it('drops details for actions that do not take any', () => {
    const entry = buildAuditEntry({ action: 'user.password_reset', details: { temporaryPassword: 'Secreto' }, at: NOW });

    expect(entry.details).toBeNull();
  });

  it('never accepts an unknown source', () => {
    expect(buildAuditEntry({ action: 'user.created', source: 'hacker', at: NOW }).source).toBe('panel');
  });
});
