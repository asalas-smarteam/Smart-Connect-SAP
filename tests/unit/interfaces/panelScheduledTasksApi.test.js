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
import { FakeAttachmentStore, FakeContextReader, InMemoryTicketRepository } from '../application/panel/ticketFakes.js';
import {
  FakeOperationsReader,
  FakeScheduledRunReader,
  FakeScheduledTaskReader,
  NEXT_RUN,
  TASK_IDS as T,
  sampleNextRuns,
  sampleOperations,
  sampleScheduledTasks,
} from '../application/panel/operationFakes.js';

const SECRET = 'panel-scheduled-tasks-api-secret-32-char';
const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';

async function buildApp() {
  const staff = staffUser();
  const ana = clientUser();
  const tokens = new HmacSessionToken({ secret: SECRET });
  const scheduledTaskReader = new FakeScheduledTaskReader(sampleScheduledTasks());
  const scheduledRunReader = new FakeScheduledRunReader(sampleNextRuns());
  const useCases = buildPanelUseCases({
    secret: SECRET,
    userRepository: new InMemoryPanelUserRepository([staff, ana]),
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    passwordHasher: new FakePasswordHasher(),
    temporaryPasswordGenerator: new SequenceTemporaryPassword(),
    loginAttempts: new FakeLoginAttempts(),
    auditLog: new RecordingAuditLog(),
    revokedSessions: new FakeRevokedSessions(),
    sessionToken: tokens,
    ticketRepository: new InMemoryTicketRepository(),
    attachmentStore: new FakeAttachmentStore(),
    contextReader: new FakeContextReader(),
    operationsReader: new FakeOperationsReader(sampleOperations()),
    scheduledTaskReader,
    scheduledRunReader,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  });
  const app = Fastify();
  app.register(panelPlugin, { prefix: '/panel/api', secret: SECRET, useCases, logger: { warn: jest.fn(), error: jest.fn() } });
  await app.ready();
  const cookieFor = (user) => `panel_session=${tokens.sign({ sub: user.id, tv: 0, pwdChange: false })}`;
  return { app, scheduledTaskReader, scheduledRunReader, cookies: { staff: cookieFor(staff), ana: cookieFor(ana) } };
}

function get(ctx, url, cookie) {
  return ctx.app.inject({ method: 'GET', url: `/panel/api${url}`, headers: cookie ? { cookie } : {} });
}

describe('/panel/api scheduled tasks (plan 7, contract 09)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('serves the client the tasks of its own company (J1, J2)', async () => {
    const response = await get(ctx, '/scheduled-tasks', ctx.cookies.ana);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body)).toEqual(['items']);
    expect(body.items.map((item) => item.id)).toEqual([T.products, T.options, T.orders]);
    expect(body.items[0]).toEqual(expect.objectContaining({
      name: 'Obtener Productos',
      type: 'record_sync',
      sourcePath: '/Items',
      mode: 'full',
      batchSize: 100,
      requireCrmIdUpdate: true,
      associationsEnabled: false,
      nextRunAt: NEXT_RUN,
    }));
    expect(body.items[0].schedule.timeZone).toBe('America/Costa_Rica');
    expect(body.items[0].lastError).not.toMatch(/10\.0\.0\.5/);
    expect(ctx.scheduledTaskReader.touchedTenants).toEqual([ACME]);
  });

  it('never sends credentials, queries or internal ids (J3), not even to Smarteam', async () => {
    for (const [url, cookie] of [['/scheduled-tasks', ctx.cookies.ana], [`/staff/tenants/${ACME}/scheduled-tasks`, ctx.cookies.staff]]) {
      const response = await get(ctx, url, cookie);
      expect(response.body).not.toMatch(/apiToken|apiUrl|sqlQuery|storeProcedureName|updateMethod|updateSpName|updateTableName|integrationModeId|hubspotCredentialId|associationFetchConfig|__v|token-secreto|SELECT/);
    }
  });

  it('serves Smarteam the raw lastError by company', async () => {
    const response = await get(ctx, `/staff/tenants/${ACME}/scheduled-tasks`, ctx.cookies.staff);

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].lastError).toMatch(/10\.0\.0\.5/);
  });

  it('answers 404 for an unknown company without reading', async () => {
    const response = await get(ctx, '/staff/tenants/sap_integration_fantasma/scheduled-tasks', ctx.cookies.staff);

    expect(response.statusCode).toBe(404);
    expect(ctx.scheduledTaskReader.touchedTenants).toEqual([]);
  });

  it('answers an empty list for a company without tasks', async () => {
    const response = await get(ctx, `/staff/tenants/${INITECH}/scheduled-tasks`, ctx.cookies.staff);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('answers 403 forbidden to the wrong kind of account and 401 without a session', async () => {
    const clientOnStaff = await get(ctx, `/staff/tenants/${ACME}/scheduled-tasks`, ctx.cookies.ana);
    const staffOnClient = await get(ctx, '/scheduled-tasks', ctx.cookies.staff);
    const anonymous = await get(ctx, '/scheduled-tasks');

    for (const response of [clientOnStaff, staffOnClient]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    }
    expect(anonymous.statusCode).toBe(401);
    expect(ctx.scheduledTaskReader.touchedTenants).toEqual([]);
  });

  it('still answers when the next runs are unavailable', async () => {
    ctx.scheduledRunReader.failNext = true;

    const response = await get(ctx, '/scheduled-tasks', ctx.cookies.ana);

    expect(response.statusCode).toBe(200);
    expect(response.json().items.every((item) => item.nextRunAt === null)).toBe(true);
  });

  it('answers 400 when the query times out', async () => {
    ctx.scheduledTaskReader.timeoutNext = true;

    expect((await get(ctx, '/scheduled-tasks', ctx.cookies.ana)).statusCode).toBe(400);
  });

  it('lists tasks.read in /auth/me for clients and Smarteam (J4)', async () => {
    for (const cookie of [ctx.cookies.ana, ctx.cookies.staff]) {
      const response = await get(ctx, '/auth/me', cookie);
      expect(response.json().permissions).toContain('tasks.read');
    }
  });
});
