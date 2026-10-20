import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración del mapeo de campos (plan 6) con una base real en memoria: lector nativo, orden,
// campos internos fuera y que leer una empresa vacía no cree su base.
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
let fieldMappings;
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
  const { buildPanelFieldMappingUseCases } = await import('../../src/composition/panel.composition.js');

  await connect();
  await SaaSClient.create([
    { companyName: 'Acme Industrial', tenantKey: ACME, status: 'active' },
    { companyName: 'Vacío', tenantKey: EMPTY, status: 'active' },
  ]);

  const db = (await getTenantConnection(ACME)).db;
  const credential = new mongoose.Types.ObjectId();
  const task = new mongoose.Types.ObjectId();
  const { insertedIds } = await db.collection('FieldMappings').insertMany([
    { sourceField: 'QuantityOnStock', targetField: 'quantity', objectType: 'product', sourceContext: 'product', isActive: true, editable: false, includeInServiceLayerSelect: false, userField: false, clientConfigId: task, hubspotCredentialId: credential },
    { sourceField: 'CardName', targetField: 'name', objectType: 'company', sourceContext: 'businessPartner', isActive: false, editable: true, includeInServiceLayerSelect: true, userField: false, clientConfigId: task, hubspotCredentialId: credential },
    { sourceField: 'U_Zona', targetField: 'zona', objectType: 'company', sourceContext: '' },
  ]);
  ids.stock = String(insertedIds[0]);
  ids.name = String(insertedIds[1]);
  ids.legacy = String(insertedIds[2]);

  ({ fieldMappings } = buildPanelFieldMappingUseCases({ logger: { warn: () => {} } }));
}, 120000);

afterAll(async () => {
  await SaaSClient?.deleteMany({});
  await disconnectTenantConnections?.();
  await disconnect?.();
  await mongoServer?.stop();
});

describe('field mappings against MongoDB (plan 6)', () => {
  it('lists every mapping of the company, sorted, without internal fields', async () => {
    const result = await fieldMappings.list({ scope: { user: client, routeTenantKey: undefined } });

    expect(result.ok).toBe(true);
    // objectType, sourceContext, sourceField: company/'' < company/businessPartner < product/product.
    expect(result.data.items.map((item) => item.id)).toEqual([ids.legacy, ids.name, ids.stock]);
    expect(result.data.items[0]).toEqual({
      id: ids.legacy,
      sourceField: 'U_Zona',
      targetField: 'zona',
      objectType: 'company',
      sourceContext: null,
      isActive: true,
      editable: true,
      includeInSourceQuery: true,
      userField: false,
    });
    expect(result.data.items[1].isActive).toBe(false);
    expect(result.data.items[2].includeInSourceQuery).toBe(false);
    expect(JSON.stringify(result.data)).not.toMatch(/clientConfigId|hubspotCredentialId/);
  });

  it('gives Smarteam the same list and 404 for an unknown company', async () => {
    const asStaff = await fieldMappings.list({ scope: { user: staff, routeTenantKey: ACME } });
    const unknown = await fieldMappings.list({ scope: { user: staff, routeTenantKey: 'sap_integration_fantasma' } });

    expect(asStaff.data.items).toHaveLength(3);
    expect(unknown).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('answers an empty list and never creates a database by reading an empty company', async () => {
    const result = await fieldMappings.list({ scope: { user: staff, routeTenantKey: EMPTY } });

    expect(result).toEqual({ ok: true, data: { items: [] } });
    expect(await databaseNames()).not.toContain(EMPTY);
  });
});
