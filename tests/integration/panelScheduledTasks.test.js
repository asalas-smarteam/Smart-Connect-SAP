import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración de tareas programadas (plan 7) con una base real en memoria: lector nativo, orden,
// campos internos fuera y que leer una empresa vacía no cree su base. Las próximas ejecuciones
// (Redis) se reemplazan por un lector falso.
const ACME = 'sap_integration_acme';
const EMPTY = 'sap_integration_vacio';
const client = { id: 'u1', accountType: 'cliente', tenantKey: ACME };
const staff = { id: 'u2', accountType: 'smarteam', tenantKey: null };

let mongoServer;
let connect;
let disconnect;
let SaaSClient;
let getTenantConnection;
let disconnectTenantConnections;
let scheduledTasks;
const ids = {};

async function databaseNames() {
  const { databases } = await mongoose.connection.db.admin().listDatabases();
  return databases.map((database) => database.name);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  process.env.MONGODB_URI = mongoServer.getUri();

  ({ connect, disconnect, SaaSClient } = await import('../../src/infrastructure/database/master/database.js'));
  ({ getTenantConnection, disconnectTenantConnections } = await import('../../src/infrastructure/database/tenant/tenantDatabase.js'));
  const { buildPanelScheduledTaskUseCases } = await import('../../src/composition/panel.composition.js');

  await connect();
  await SaaSClient.create([
    { companyName: 'Acme Industrial', tenantKey: ACME, status: 'active' },
    { companyName: 'Vacío', tenantKey: EMPTY, status: 'active' },
  ]);

  const db = (await getTenantConnection(ACME)).db;
  const { insertedIds } = await db.collection('ClientConfigs').insertMany([
    { clientName: 'Pedidos', taskType: 'SAP_SYNC', mode: 'INCREMENTAL', intervalMinutes: 15, active: false, apiToken: 'token-secreto', sqlQuery: 'SELECT 1', externalDbPassword: 'clave-externa' },
    { clientName: 'Productos', taskType: 'SAP_SYNC', objectType: 'Product', serviceLayerPath: '/Items', mode: 'FULL', executionTime: ['07:00'], executionDays: ['Monday'], hubspotBatchSize: 100, active: true, apiUrl: 'https://10.0.0.5:50000', hubspotCredentialId: new mongoose.Types.ObjectId(), lastError: 'connect ECONNREFUSED 10.0.0.5:50000' },
    { clientName: 'Bodegas', taskType: 'DROPDOWN_OPTIONS', mode: 'FULL', active: true },
  ]);
  ids.orders = String(insertedIds[0]);
  ids.products = String(insertedIds[1]);
  ids.warehouses = String(insertedIds[2]);

  const scheduledRunReader = {
    async nextRunsFor() {
      return new Map([[ids.products, new Date('2026-10-21T13:00:00Z')]]);
    },
  };
  ({ scheduledTasks } = buildPanelScheduledTaskUseCases({ scheduledRunReader, logger: { warn: () => {} } }));
}, 120000);

afterAll(async () => {
  await SaaSClient?.deleteMany({});
  await disconnectTenantConnections?.();
  await disconnect?.();
  await mongoServer?.stop();
});

describe('scheduled tasks against MongoDB (plan 7)', () => {
  it('lists active tasks first and then by name, without credentials or queries', async () => {
    const result = await scheduledTasks.list({ scope: { user: client, routeTenantKey: undefined } });

    expect(result.ok).toBe(true);
    expect(result.data.items.map((item) => item.id)).toEqual([ids.warehouses, ids.products, ids.orders]);
    expect(result.data.items[1]).toEqual(expect.objectContaining({
      name: 'Productos',
      objectType: 'product',
      sourcePath: '/Items',
      mode: 'full',
      batchSize: 100,
      nextRunAt: '2026-10-21T13:00:00.000Z',
    }));
    expect(result.data.items[1].lastError).not.toMatch(/10\.0\.0\.5/);
    expect(result.data.items[0].type).toBe('dropdown_options');
    expect(JSON.stringify(result.data)).not.toMatch(/apiToken|apiUrl|sqlQuery|hubspotCredentialId|externalDb|token-secreto|clave-externa|SELECT/);
  });

  it('gives Smarteam the raw error and 404 for an unknown company', async () => {
    const asStaff = await scheduledTasks.list({ scope: { user: staff, routeTenantKey: ACME } });
    const unknown = await scheduledTasks.list({ scope: { user: staff, routeTenantKey: 'sap_integration_fantasma' } });

    expect(asStaff.data.items[1].lastError).toMatch(/10\.0\.0\.5/);
    expect(unknown).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('answers an empty list and never creates a database by reading an empty company', async () => {
    const result = await scheduledTasks.list({ scope: { user: staff, routeTenantKey: EMPTY } });

    expect(result).toEqual({ ok: true, data: { items: [] } });
    expect(await databaseNames()).not.toContain(EMPTY);
  });
});
