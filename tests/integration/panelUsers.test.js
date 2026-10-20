import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import Fastify from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración del panel con una base real en memoria: modelo PanelUser, repositorio Mongoose,
// scrypt real, plugin HTTP completo y el script de la primera cuenta.
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'panel-integration-secret-at-least-32-chars';
const PANEL = { 'x-panel-request': '1' };

let mongoServer;
let connect;
let disconnect;
let SaaSClient;
let PanelUser;
let PanelAuditLog;
let PanelRevokedSession;
let MongoosePanelUserRepository;
let buildPanelUseCases;
let buildManagePanelUsers;
let panelPlugin;
let app;

class MemoryLoginAttempts {
  constructor() {
    this.failures = new Map();
  }

  async consume(email) {
    const count = (this.failures.get(email) ?? 0) + 1;
    this.failures.set(email, count);
    return { blocked: count > 5, firstBlocked: count === 6 };
  }

  async reset(email) {
    this.failures.delete(email);
  }
}

function sessionCookie(response) {
  const cookie = response.cookies.find((candidate) => candidate.name === 'panel_session');
  return cookie ? `panel_session=${cookie.value}` : null;
}

async function runScript(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['scripts/create-panel-staff.mjs', ...args],
      { cwd: projectRoot, env: { ...process.env, MONGODB_URI: mongoServer.getUri() } }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  process.env.MONGODB_URI = mongoServer.getUri();

  ({ connect, disconnect, SaaSClient } = await import('../../src/infrastructure/database/master/database.js'));
  ({ default: PanelUser } = await import('../../src/infrastructure/database/models/global/PanelUser.js'));
  ({ default: PanelAuditLog } = await import('../../src/infrastructure/database/models/global/PanelAuditLog.js'));
  ({ default: PanelRevokedSession } = await import('../../src/infrastructure/database/models/global/PanelRevokedSession.js'));
  ({ default: MongoosePanelUserRepository } = await import('../../src/infrastructure/database/repositories/MongoosePanelUserRepository.js'));
  ({ buildPanelUseCases, buildManagePanelUsers } = await import('../../src/composition/panel.composition.js'));
  ({ default: panelPlugin } = await import('../../src/interfaces/http/panel/panelPlugin.js'));

  await connect();
  await PanelUser.init();
  await PanelAuditLog.init();
  await PanelRevokedSession.init();
  await SaaSClient.create({ companyName: 'Acme Industrial', tenantKey: 'sap_integration_acme', status: 'active' });

  app = Fastify();
  app.register(panelPlugin, {
    prefix: '/panel/api',
    secret: SECRET,
    useCases: buildPanelUseCases({ secret: SECRET, loginAttempts: new MemoryLoginAttempts() }),
    trustedProxies: [],
    logger: { warn: () => {}, error: () => {} },
  });
  await app.ready();
}, 120000);

afterEach(async () => {
  await PanelUser.deleteMany({});
  await PanelAuditLog.deleteMany({});
  await PanelRevokedSession.deleteMany({});
});

afterAll(async () => {
  await app?.close();
  await PanelUser?.deleteMany({});
  await SaaSClient?.deleteMany({});
  await disconnect?.();
  await mongoServer?.stop();
});

describe('MongoosePanelUserRepository against MongoDB', () => {
  it('enforces a case-insensitive unique email', async () => {
    const repository = new MongoosePanelUserRepository();
    const base = { name: 'Ana', accountType: 'smarteam', passwordHash: 'x' };

    await repository.create({ ...base, email: 'Ana@Smarteam.test' });

    await expect(repository.create({ ...base, email: 'ana@smarteam.TEST' }))
      .rejects.toMatchObject({ code: 'PANEL_EMAIL_TAKEN' });
  });

  it('lists newest first, paginates and filters by tenant', async () => {
    const repository = new MongoosePanelUserRepository();
    for (let index = 0; index < 3; index += 1) {
      await repository.create({
        email: `u${index}@acme.test`,
        name: `U${index}`,
        accountType: 'cliente',
        tenantKey: 'sap_integration_acme',
        role: 'usuario',
        passwordHash: 'x',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await repository.create({ email: 'dev@smarteam.test', name: 'Dev', accountType: 'smarteam', passwordHash: 'x' });

    const firstPage = await repository.list({ tenantKey: 'sap_integration_acme', page: 1, pageSize: 2 });
    const secondPage = await repository.list({ tenantKey: 'sap_integration_acme', page: 2, pageSize: 2 });
    const all = await repository.list({ tenantKey: null, page: 1, pageSize: 25 });

    expect(firstPage.total).toBe(3);
    expect(firstPage.items.map((user) => user.email)).toEqual(['u2@acme.test', 'u1@acme.test']);
    expect(secondPage.items.map((user) => user.email)).toEqual(['u0@acme.test']);
    expect(all.total).toBe(4);
    await expect(repository.findById('no-es-un-id')).resolves.toBeNull();
  });
});

describe('panel flow against MongoDB', () => {
  it('creates a client, logs in with the temporary password, changes it and reads /auth/me', async () => {
    const manageUsers = buildManagePanelUsers();
    const created = await manageUsers.create({
      email: 'mario@acme.test',
      name: 'Mario',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      role: 'usuario',
    });
    expect(created.ok).toBe(true);

    const login = await app.inject({
      method: 'POST',
      url: '/panel/api/auth/login',
      headers: PANEL,
      payload: { email: 'mario@acme.test', password: created.data.temporaryPassword },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().mustChangePassword).toBe(true);

    const change = await app.inject({
      method: 'POST',
      url: '/panel/api/auth/change-password',
      headers: { ...PANEL, cookie: sessionCookie(login) },
      payload: { currentPassword: created.data.temporaryPassword, newPassword: 'mi-clave-nueva-larga' },
    });
    expect(change.statusCode).toBe(204);

    const me = await app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: sessionCookie(change) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(expect.objectContaining({
      companyName: 'Acme Industrial',
      mustChangePassword: false,
      tenantKey: 'sap_integration_acme',
    }));

    const stored = await PanelUser.findOne({ email: 'mario@acme.test' }).lean();
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.tokenVersion).toBe(1);
    expect(stored.lastLoginAt).toBeInstanceOf(Date);

    const audit = await PanelAuditLog.find({}).sort({ at: 1, _id: 1 }).lean();
    expect(audit.map((entry) => entry.action)).toEqual(['user.created', 'auth.login_succeeded', 'auth.password_changed']);
    expect(audit[0].expiresAt).toBeNull();
    expect(audit[1].expiresAt).toBeInstanceOf(Date);
    expect(JSON.stringify(audit)).not.toContain(created.data.temporaryPassword);
  });

  it('revokes only the session that logs out', async () => {
    const created = await buildManagePanelUsers().create({ email: 'dos@smarteam.test', name: 'Dos', accountType: 'smarteam' });
    const loginOnce = () => app.inject({
      method: 'POST',
      url: '/panel/api/auth/login',
      headers: PANEL,
      payload: { email: 'dos@smarteam.test', password: created.data.temporaryPassword },
    });
    const first = sessionCookie(await loginOnce());
    const second = sessionCookie(await loginOnce());

    const logout = await app.inject({ method: 'POST', url: '/panel/api/auth/logout', headers: { ...PANEL, cookie: first } });
    const meFirst = await app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: first } });
    const meSecond = await app.inject({ method: 'GET', url: '/panel/api/auth/me', headers: { cookie: second } });

    expect(logout.statusCode).toBe(204);
    expect(meFirst.statusCode).toBe(401);
    expect(meSecond.statusCode).toBe(200);
    expect(await PanelRevokedSession.countDocuments()).toBe(1);

    // Revocar dos veces la misma sesión no falla (upsert idempotente).
    const again = await app.inject({ method: 'POST', url: '/panel/api/auth/logout', headers: { ...PANEL, cookie: first } });
    expect(again.statusCode).toBe(204);
    expect(await PanelRevokedSession.countDocuments()).toBe(1);
  });
});

describe('scripts/create-panel-staff.mjs', () => {
  it('creates a smarteam account, prints only the temporary password, and refuses a duplicate', async () => {
    const first = await runScript(['primer@smarteam.test', 'Primer', 'Dev']);

    expect(first.code).toBe(0);
    expect(first.stdout.trim()).toMatch(/^[A-HJ-NP-Za-hj-km-np-z2-9]{14}$/);
    const stored = await PanelUser.findOne({ email: 'primer@smarteam.test' }).lean();
    const [audit] = await PanelAuditLog.find({ action: 'user.created' }).lean();
    expect(audit).toEqual(expect.objectContaining({ source: 'script', actor: null }));
    expect(stored).toEqual(expect.objectContaining({
      name: 'Primer Dev',
      accountType: 'smarteam',
      tenantKey: null,
      role: null,
      mustChangePassword: true,
    }));

    const second = await runScript(['primer@smarteam.test', 'Otro']);

    expect(second.code).toBe(1);
    expect(second.stdout.trim()).toBe('');
    expect(second.stderr).toContain('Ya existe un usuario con ese correo.');
  }, 60000);

  it('exits with code 1 when arguments are missing', async () => {
    const result = await runScript(['solo@smarteam.test']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Uso:');
  }, 60000);
});
