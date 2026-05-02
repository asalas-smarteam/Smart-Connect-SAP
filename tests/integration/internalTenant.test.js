import request from 'supertest';
import { jest } from '@jest/globals';
import { MongoMemoryServer } from 'mongodb-memory-server';

let app;
let connect;
let disconnect;
let SaaSClient;
let Subscription;
let GlobalAuditLog;
let disconnectTenantConnections;
let mongoServer;

const INTERNAL_KEY = 'test-internal-key';
const TENANT_PREFIX = 'testprefix';
const PLAN_ID = '64f000000000000000000001';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.INTERNAL_KEY = INTERNAL_KEY;
  process.env.SAP_SYNC_CRON_ENABLED = 'false';
  process.env.WEBHOOK_PROCESSOR_CRON_ENABLED = 'false';
  process.env.TENANT_DB_PREFIX = TENANT_PREFIX;

  const dbModule = await import('../../src/config/database.js');
  connect = dbModule.connect;
  disconnect = dbModule.disconnect;
  SaaSClient = dbModule.SaaSClient;
  Subscription = dbModule.Subscription;
  GlobalAuditLog = dbModule.GlobalAuditLog;

  const tenantDbModule = await import('../../src/config/tenantDatabase.js');
  disconnectTenantConnections = tenantDbModule.disconnectTenantConnections;

  const appModule = await import('../../src/app.js');
  app = appModule.default;

  await connect();
  await app.ready();
});

afterEach(async () => {
  if (GlobalAuditLog && SaaSClient && Subscription) {
    await Promise.all([
      GlobalAuditLog.deleteMany({}),
      SaaSClient.deleteMany({}),
      Subscription.deleteMany({}),
    ]);
  }
  jest.restoreAllMocks();
});

afterAll(async () => {
  if (app) {
    await app.close();
  }
  const [{ closeWebhookQueue }, { closeSapSyncQueue }, { closeSharedBullMQConnection }] = await Promise.all([
    import('../../src/queues/webhook.queue.js'),
    import('../../src/queues/sapSync.queue.js'),
    import('../../src/lib/bullmqRedis.js'),
  ]);
  await closeWebhookQueue();
  await closeSapSyncQueue();
  await closeSharedBullMQConnection();
  if (disconnectTenantConnections) {
    await disconnectTenantConnections();
  }
  if (disconnect) {
    await disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe('POST /internal/tenant', () => {
  it('creates tenant successfully and records audit log', async () => {
    const payload = {
      nombreEmpresa: 'Acme Inc',
      planId: PLAN_ID,
      billingEmail: 'billing@acme.test',
      hubspot: { portalId: 123 },
    };

    const response = await request(app.server)
      .post('/internal/tenant')
      .set('x-internal-key', INTERNAL_KEY)
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tenantId: expect.any(String),
      tenantKey: `${TENANT_PREFIX}_acme_inc`,
      nombreColeccion: `${TENANT_PREFIX}_acme_inc`,
      estadoSuscripcion: 'active',
    });

    const createdClient = await SaaSClient.findOne({ tenantKey: `${TENANT_PREFIX}_acme_inc` });
    expect(createdClient).not.toBeNull();

    const createdSubscription = await Subscription.findOne({ clientId: createdClient._id });
    expect(createdSubscription).not.toBeNull();

    const auditLog = await GlobalAuditLog.findOne({ action: 'tenant.provisioned' });
    expect(auditLog).not.toBeNull();
    expect(auditLog.payload).toMatchObject({
      companyName: 'Acme Inc',
      planId: PLAN_ID,
      billingEmail: 'billing@acme.test',
      hubspot: { portalId: 123 },
    });
  });

  it('rejects requests with invalid internal key', async () => {
    const response = await request(app.server)
      .post('/internal/tenant')
      .set('x-internal-key', 'wrong-key')
      .send({ nombreEmpresa: 'Acme Inc', planId: PLAN_ID });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Invalid internal key' });

    expect(await SaaSClient.countDocuments()).toBe(0);
    expect(await Subscription.countDocuments()).toBe(0);
    expect(await GlobalAuditLog.countDocuments()).toBe(0);
  });

  it('validates required fields in the body', async () => {
    const response = await request(app.server)
      .post('/internal/tenant')
      .set('x-internal-key', INTERNAL_KEY)
      .send({ nombreEmpresa: 'Acme Inc' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'planId is required' });

    expect(await SaaSClient.countDocuments()).toBe(0);
    expect(await Subscription.countDocuments()).toBe(0);
    expect(await GlobalAuditLog.countDocuments()).toBe(0);
  });

  it('returns an error when tenant creation fails and writes audit log', async () => {
    const createError = new Error('create failed');
    jest.spyOn(SaaSClient, 'create').mockRejectedValueOnce(createError);

    const response = await request(app.server)
      .post('/internal/tenant')
      .set('x-internal-key', INTERNAL_KEY)
      .send({ nombreEmpresa: 'Broken Inc', planId: PLAN_ID });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'create failed' });

    expect(await SaaSClient.countDocuments()).toBe(0);
    expect(await Subscription.countDocuments()).toBe(0);

    const auditLog = await GlobalAuditLog.findOne({ action: 'tenant.provisioning_failed' });
    expect(auditLog).not.toBeNull();
    expect(auditLog.payload).toMatchObject({
      companyName: 'Broken Inc',
      planId: PLAN_ID,
    });
    expect(auditLog.payload.error.message).toBe('create failed');
  });
});
