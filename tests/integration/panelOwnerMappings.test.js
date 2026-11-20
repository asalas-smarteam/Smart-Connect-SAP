import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración del mapeo de responsables (plan 11) con una base real en memoria: lector nativo,
// campos internos fuera, valores tal cual y que leer una empresa vacía no cree su base.
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
let ownerMappings;
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
  const { buildPanelOwnerMappingUseCases } = await import('../../src/composition/panel.composition.js');

  await connect();
  await SaaSClient.create([
    { companyName: 'Acme Industrial', tenantKey: ACME, status: 'active' },
    { companyName: 'Vacío', tenantKey: EMPTY, status: 'active' },
  ]);

  const db = (await getTenantConnection(ACME)).db;
  const credential = new mongoose.Types.ObjectId();
  const { insertedIds } = await db.collection('OwnerMappings').insertMany([
    { hubspotCredentialId: credential, hubspotOwnerId: '82929225', hubspotOwnerName: 'Erick', hubspotOwnerEmail: 'e@acme.test', sapOwnerId: '53', sapOwnerName: null, sapOwnerId_2: '67', active: true, source: 'hubspot_seed', createdAt: new Date('2026-07-03T02:03:51.125Z'), updatedAt: new Date('2026-07-03T02:03:51.125Z'), __v: 0 },
    { hubspotCredentialId: credential, hubspotOwnerId: '91000001', hubspotOwnerName: 'Ana', sapOwnerId: '113,758,864', active: false, source: 'manual' },
  ]);
  ids.erick = String(insertedIds[0]);
  ids.ana = String(insertedIds[1]);

  ({ ownerMappings } = buildPanelOwnerMappingUseCases({ logger: { warn: () => {} } }));
}, 120000);

afterAll(async () => {
  await SaaSClient?.deleteMany({});
  await disconnectTenantConnections?.();
  await disconnect?.();
  await mongoServer?.stop();
});

describe('owner mappings against MongoDB (plan 11)', () => {
  it('lists every record with generic names, values as stored and no internal fields', async () => {
    const result = await ownerMappings.list({ scope: { user: client, routeTenantKey: undefined } });

    expect(result.ok).toBe(true);
    expect(result.data.items.map((item) => item.id)).toEqual([ids.ana, ids.erick]);
    expect(result.data.items[1]).toEqual({
      id: ids.erick,
      crmOwnerId: '82929225',
      crmOwnerName: 'Erick',
      crmOwnerEmail: 'e@acme.test',
      erpOwnerId: '53',
      erpOwnerName: null,
      erpEmployeeId: '67',
      active: true,
      source: 'crm_seed',
      createdAt: '2026-07-03T02:03:51.125Z',
      updatedAt: '2026-07-03T02:03:51.125Z',
    });
    expect(result.data.items[0]).toEqual(expect.objectContaining({ erpOwnerId: '113,758,864', crmOwnerEmail: null, active: false, createdAt: null }));
    expect(JSON.stringify(result.data)).not.toMatch(/hubspotCredentialId|__v/);
  });

  it('gives Smarteam the same list and 404 for an unknown company', async () => {
    const asStaff = await ownerMappings.list({ scope: { user: staff, routeTenantKey: ACME } });
    const unknown = await ownerMappings.list({ scope: { user: staff, routeTenantKey: 'sap_integration_fantasma' } });

    expect(asStaff.data.items).toHaveLength(2);
    expect(unknown).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('answers an empty list and never creates a database by reading an empty company', async () => {
    const result = await ownerMappings.list({ scope: { user: staff, routeTenantKey: EMPTY } });

    expect(result).toEqual({ ok: true, data: { items: [] } });
    expect(await databaseNames()).not.toContain(EMPTY);
  });
});
