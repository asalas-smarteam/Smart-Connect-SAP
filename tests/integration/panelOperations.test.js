import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración de Eventos y Syncs con una base real en memoria: lector nativo, filtros, errores
// paginados, que leer no cree bases y el script de índices (dry run y --apply).
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ACME = 'sap_integration_acme';
const GLOBEX = 'sap_integration_globex';
const EMPTY = 'sap_integration_vacio';
const client = { id: 'u1', accountType: 'cliente', tenantKey: ACME };
const staff = { id: 'u2', accountType: 'smarteam', tenantKey: null };
const clientScope = { user: client, routeTenantKey: undefined };

let mongoServer;
let connect;
let disconnect;
let SaaSClient;
let getTenantConnection;
let disconnectTenantConnections;
let buildPanelOperationUseCases;
let operations;
const ids = {};

async function databaseNames() {
  const { databases } = await mongoose.connection.db.admin().listDatabases();
  return databases.map((database) => database.name);
}

async function runScript(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['scripts/create-panel-operation-indexes.mjs', ...args],
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
  ({ getTenantConnection, disconnectTenantConnections } = await import('../../src/infrastructure/database/tenant/tenantDatabase.js'));
  ({ buildPanelOperationUseCases } = await import('../../src/composition/panel.composition.js'));

  await connect();
  await SaaSClient.create([
    { companyName: 'Acme Industrial', tenantKey: ACME, status: 'active' },
    { companyName: 'Globex', tenantKey: GLOBEX, status: 'suspended' },
    { companyName: 'Vacío', tenantKey: EMPTY, status: 'active' },
  ]);

  const db = (await getTenantConnection(ACME)).db;
  const task = await db.collection('ClientConfigs').insertOne({ clientName: 'Productos', taskType: 'SAP_SYNC', apiToken: 'secreto-de-prueba' });
  ids.task = String(task.insertedId);
  const events = await db.collection('WebhookEvents').insertMany([
    { eventType: 'createQuotation', status: 'errored', lastError: 'boom', payload: { deal: { hs_object_id: '111' } }, sapAudit: { x: 'interno' }, createdAt: new Date('2026-10-05T10:00:00Z'), updatedAt: new Date('2026-10-05T10:00:00Z') },
    { eventType: 'createDeal', status: 'sap_order_created', payload: { deal: { hs_object_id: 222 } }, createdAt: new Date('2026-10-07T10:00:00Z'), updatedAt: new Date('2026-10-07T10:00:00Z') },
    { eventType: 'syncReport', status: 'report', payload: { rows: [] }, createdAt: new Date('2026-10-08T10:00:00Z') },
  ]);
  ids.errored = String(events.insertedIds[0]);
  ids.report = String(events.insertedIds[2]);
  const sync = await db.collection('SyncLogs').insertOne({
    clientConfigId: task.insertedId,
    objectType: 'Product',
    status: 'errored',
    recordsProcessed: 60,
    failed: 60,
    errors: Array.from({ length: 60 }, (_, index) => ({ record: `ITEM-${index}`, message: 'Sin precio' })),
    startedAt: new Date('2026-10-06T06:00:00Z'),
  });
  ids.sync = String(sync.insertedId);
  // Vuelta de la cola de eventos: sin tarea, vacía, con errores internos guardados.
  await db.collection('SyncLogs').insertOne({
    objectType: 'Deal',
    status: 'errored',
    recordsProcessed: 0,
    errorMessage: [{ payload_SAP: { CardCode: 'C1' }, response_hubspot: { status: 500 } }],
    startedAt: new Date('2026-10-06T07:00:00Z'),
  });
  await (await getTenantConnection(GLOBEX)).db.collection('WebhookEvents').insertOne({ eventType: 'createDeal', status: 'completed', payload: {}, createdAt: new Date() });

  ({ operations } = buildPanelOperationUseCases({ logger: { warn: () => {} } }));
}, 120000);

afterAll(async () => {
  await SaaSClient?.deleteMany({});
  await disconnectTenantConnections?.();
  await disconnect?.();
  await mongoServer?.stop();
});

describe('events and syncs against MongoDB', () => {
  it('filters events by status, dates and reference stored as text or number, never reports', async () => {
    const list = async (query) => (await operations.listEvents({ scope: clientScope, query })).data;

    expect((await list({})).total).toBe(2);
    expect((await list({ status: 'destination_created' })).items.map((event) => event.type)).toEqual(['createDeal']);
    expect((await list({ from: '2026-10-06T00:00:00.000Z' })).total).toBe(1);
    expect((await list({ to: '2026-10-07T10:00:00.000Z' })).total).toBe(1);
    expect((await list({ reference: '111' })).total).toBe(1);
    expect((await list({ reference: '222' })).total).toBe(1);
    expect(await operations.getEvent({ scope: clientScope, id: ids.report })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('returns payload and audit only when asked', async () => {
    const plain = await operations.getEvent({ scope: clientScope, id: ids.errored });
    const raw = await operations.getEvent({ scope: { user: staff, routeTenantKey: ACME }, id: ids.errored, withRaw: true });

    expect(plain.data).not.toHaveProperty('audit');
    expect(raw.data.audit).toEqual({ x: 'interno' });
  });

  it('keeps tenants apart', async () => {
    expect(await operations.getEvent({ scope: { user: staff, routeTenantKey: GLOBEX }, id: ids.errored })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('pages the errors of a sync inside the document and never leaks task credentials', async () => {
    const detail = await operations.getSync({ scope: clientScope, id: ids.sync, query: { errorsPage: '3', errorsPageSize: '25' } });
    const tasks = await operations.listTasks({ scope: clientScope });

    expect(detail.data.errors).toEqual(expect.objectContaining({ page: 3, pageSize: 25, total: 60 }));
    expect(detail.data.errors.items.map((error) => error.record)).toEqual(Array.from({ length: 10 }, (_, index) => `ITEM-${50 + index}`));
    expect(detail.data.task).toEqual({ id: ids.task, name: 'Productos', type: 'record_sync' });
    expect(JSON.stringify([detail.data, tasks.data])).not.toContain('secreto-de-prueba');
  });

  it('never creates a database by reading an empty tenant', async () => {
    const staffScope = { user: staff, routeTenantKey: EMPTY };
    await operations.listEvents({ scope: staffScope });
    await operations.listSyncs({ scope: staffScope });
    await operations.listTasks({ scope: staffScope });

    expect(await databaseNames()).not.toContain(EMPTY);
  });
});

describe('scripts/create-panel-operation-indexes.mjs', () => {
  async function indexKeys(name) {
    const db = (await getTenantConnection(ACME)).db;
    return (await db.collection(name).indexes()).map((index) => JSON.stringify(index.key));
  }

  it('reports without writing on a dry run', async () => {
    const before = await indexKeys('WebhookEvents');

    const result = await runScript([ACME]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('WebhookEvents: 3 documento(s)');
    expect(result.stdout).toContain('Dry run');
    expect(await indexKeys('WebhookEvents')).toEqual(before);
  });

  it('creates the six indexes with --apply and nothing on a second run', async () => {
    const first = await runScript([ACME, '--apply']);
    const second = await runScript([ACME, '--apply']);

    expect(first.stdout).toContain('6 índice(s) creado(s)');
    expect(second.stdout).toContain('0 índice(s) creado(s)');
    expect(await indexKeys('WebhookEvents')).toEqual(expect.arrayContaining([
      JSON.stringify({ createdAt: -1 }),
      JSON.stringify({ status: 1, createdAt: -1 }),
      JSON.stringify({ 'payload.deal.hs_object_id': 1, createdAt: -1 }),
    ]));
    expect(await indexKeys('SyncLogs')).toEqual(expect.arrayContaining([
      JSON.stringify({ startedAt: -1 }),
      JSON.stringify({ clientConfigId: 1, startedAt: -1 }),
      JSON.stringify({ startedAt: -1, _id: -1 }),
    ]));
  });

  it('refuses a database that is not a tenant database', async () => {
    const result = await runScript(['admin']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must start with');
  });

  it('refuses an unknown database without creating it', async () => {
    const result = await runScript(['sap_integration_typo', '--apply']);

    expect(result.code).toBe(1);
    expect(await databaseNames()).not.toContain('sap_integration_typo');
  });
});

describe('plan 5 against MongoDB', () => {
  it('shows queue runs as the event queue, hides empty runs and never leaks run payloads to clients', async () => {
    const queue = await operations.listSyncs({ scope: clientScope, query: { taskId: 'event_queue' } });
    const nonEmpty = await operations.listSyncs({ scope: clientScope, query: { hideEmpty: 'true' } });
    const staffRuns = await operations.listSyncs({ scope: { user: staff, routeTenantKey: ACME }, query: { taskId: 'event_queue' } });

    expect(queue.data.items).toHaveLength(1);
    expect(queue.data.items[0].task).toEqual({ id: 'event_queue', name: 'Cola de eventos', type: 'event_queue' });
    expect(queue.data.items[0].errorMessage).toEqual({ summary: '1 error(es) en la corrida' });
    expect(JSON.stringify(queue.data)).not.toMatch(/payload_|response_|CardCode/);
    expect(staffRuns.data.items[0].errorMessage[0].payload_SAP).toEqual({ CardCode: 'C1' });
    expect(nonEmpty.data.items.map((sync) => sync.id)).toEqual([ids.sync]);
  });

  it('builds the integration dashboard from real documents', async () => {
    const result = await operations.dashboard({
      scope: clientScope,
      query: { from: '2026-10-05T06:00:00.000Z', to: '2026-10-08T06:00:00.000Z', tz: 'America/Costa_Rica' },
    });

    expect(result.data.totals).toEqual(expect.objectContaining({ documents: 2, created: 1, errored: 1, pending: 0 }));
    expect(result.data.byDay.map((day) => day.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    expect(JSON.stringify(result.data)).not.toContain('interno');
  });

  it('runs the read-only diagnostic without writing', async () => {
    const before = await databaseNames();
    let output;
    try {
      output = await execFileAsync(process.execPath, ['scripts/panel-operations-report.mjs', ACME], {
        cwd: projectRoot,
        env: { ...process.env, MONGODB_URI: mongoServer.getUri() },
      });
    } catch (error) {
      output = error;
    }

    expect(output.stdout).toContain('SIN tarea | Deal | vacía');
    expect(output.stdout).toContain('payload_SAP');
    expect(await databaseNames()).toEqual(before);
  });
});

describe('plan 5b against MongoDB', () => {
  it('derives the errors of a queue run from errorMessage, with event ids', async () => {
    const db = (await getTenantConnection(ACME)).db;
    const started = new Date('2026-10-09T10:00:00Z');
    const failed = await db.collection('WebhookEvents').insertMany([
      { eventType: 'createDeal', status: 'errored', lastError: 'x', payload: { deal: { hs_object_id: '901' } }, createdAt: started, updatedAt: new Date('2026-10-09T10:00:10Z') },
      { eventType: 'createDeal', status: 'errored', lastError: 'y', payload: { deal: { hs_object_id: 902 } }, createdAt: started, updatedAt: new Date('2026-10-09T10:00:11Z') },
    ]);
    const run = await db.collection('SyncLogs').insertOne({
      objectType: 'Deal',
      status: 'errored',
      recordsProcessed: 2,
      failed: 2,
      errors: [],
      errorMessage: [
        { payload_Hubspot: { deal: { hs_object_id: '901' } }, payload_SAP: null, response_hubspot: null, response_SAP: { message: 'El Correo Electrónico del Socio no puede ser omitido.' } },
        { payload_Hubspot: { deal: { hs_object_id: 902 } }, payload_SAP: { CardCode: 'C9' }, response_hubspot: null, response_SAP: { error: { message: 'connect ETIMEDOUT 10.1.1.1:443' } } },
      ],
      startedAt: started,
      finishedAt: new Date('2026-10-09T10:00:30Z'),
    });

    const detail = await operations.getSync({ scope: clientScope, id: String(run.insertedId) });

    expect(detail.data.errors).toEqual({
      items: [
        { record: '901', message: 'El Correo Electrónico del Socio no puede ser omitido.', eventId: String(failed.insertedIds[0]) },
        { record: '902', message: 'Tiempo de espera agotado.', eventId: String(failed.insertedIds[1]) },
      ],
      page: 1,
      pageSize: 25,
      total: 2,
    });
    expect(detail.data.errors.total).toBe(detail.data.counts.failed);
    expect(detail.data.errorMessage).toEqual({ summary: '2 errores en la corrida: El Correo Electrónico del Socio no puede ser omitido.' });
    expect(JSON.stringify(detail.data)).not.toMatch(/payload_|response_|CardCode|10\.1\.1\.1/);
  });
});

describe('plan 5c against MongoDB', () => {
  it('returns the event exchange, without credentials for the client', async () => {
    const db = (await getTenantConnection(ACME)).db;
    const inserted = await db.collection('WebhookEvents').insertOne({
      eventType: 'createQuotation',
      status: 'errored',
      lastError: '10001071 - Customer CLO017007 is inactive',
      payload: { portalId: '50082681', deal: { hs_object_id: '7001', dealname: 'Renta' } },
      sapAudit: {
        payloadSap: { quotation: { CardCode: 'CLO017007' } },
        responseSap: { businessPartner: { businessPartner: { CardCode: 'CLO017007', ContactEmployees: [{ Name: 'Mario', Password: '12017' }] } } },
        sapCalls: [{ path: '/b1s/v1/BusinessPartners', ok: true }],
      },
      createdAt: new Date('2026-08-14T19:19:34Z'),
      updatedAt: new Date('2026-08-14T19:19:40Z'),
    });
    const id = String(inserted.insertedId);

    const client = await operations.getEvent({ scope: clientScope, id });
    const staffView = await operations.getEvent({ scope: { user: staff, routeTenantKey: ACME }, id });

    expect(client.data.exchange.received.deal.dealname).toBe('Renta');
    expect(client.data.exchange.sent).toEqual({ quotation: { CardCode: 'CLO017007' } });
    expect(client.data.exchange.response.businessPartner.businessPartner.ContactEmployees).toEqual([{ Name: 'Mario' }]);
    expect(JSON.stringify(client.data)).not.toMatch(/12017|sapCalls|b1s/);
    expect(staffView.data.exchange.response.businessPartner.businessPartner.ContactEmployees[0].Password).toBe('12017');
    expect(JSON.stringify(staffView.data.exchange)).not.toContain('sapCalls');
  });
});

