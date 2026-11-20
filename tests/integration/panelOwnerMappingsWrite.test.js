import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración de la edición del mapeo de responsables (plan 12, contrato 14) con una base real en
// memoria: versión con updatedAt, índice único real del vendedor, historial en la base del tenant
// correcto y sincronización con un CRM falso (adaptador real, token y HubSpot simulados).
const ACME = 'sap_integration_acme';
const OTHER = 'sap_integration_otra';
const acmeAdmin = { id: 'u1', name: 'Adriana Solís', email: 'admin@acme.test', accountType: 'cliente', role: 'admin', tenantKey: ACME };
const otherAdmin = { id: 'u3', name: 'Otro', email: 'admin@otra.test', accountType: 'cliente', role: 'admin', tenantKey: OTHER };
const staff = { id: 'u2', name: 'Dev Smarteam', email: 'dev@smarteam.test', accountType: 'smarteam', tenantKey: null };
const acmeScope = { user: acmeAdmin, routeTenantKey: undefined };
const staffScope = (tenantKey) => ({ user: staff, routeTenantKey: tenantKey });

let mongoServer;
let connect;
let disconnect;
let SaaSClient;
let getTenantConnection;
let disconnectTenantConnections;
let getPanelTenantModels;
let useCases;
let crmOwners;
let refreshAccessToken;
let fetchOwners;
const ids = {};
const credentialId = new mongoose.Types.ObjectId();

async function acmeModels() {
  return getPanelTenantModels(ACME);
}

async function rowOf(id) {
  const { OwnerMapping } = await acmeModels();
  return OwnerMapping.findById(id).lean();
}

async function historyIn(tenantKey) {
  const { db } = await getTenantConnection(tenantKey);
  return db.collection('OwnerMappingHistory').find({}).sort({ changedAt: 1, _id: 1 }).toArray();
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  process.env.MONGODB_URI = mongoServer.getUri();

  ({ connect, disconnect, SaaSClient } = await import('../../src/infrastructure/database/master/database.js'));
  ({ getTenantConnection, disconnectTenantConnections } = await import('../../src/infrastructure/database/tenant/tenantDatabase.js'));
  ({ getPanelTenantModels } = await import('../../src/infrastructure/database/repositories/panelTenantModels.js'));
  const { buildPanelOwnerMappingUseCases } = await import('../../src/composition/panel.composition.js');
  const { default: HubspotCrmOwnerDirectory } = await import('../../src/infrastructure/hubspot/HubspotCrmOwnerDirectory.js');
  const { default: hubspotAuthService } = await import('../../src/infrastructure/hubspot/hubspotAuthService.js');

  await connect();
  await SaaSClient.create([
    { companyName: 'Acme Industrial', tenantKey: ACME, status: 'active' },
    { companyName: 'Otra', tenantKey: OTHER, status: 'active' },
  ]);

  const { OwnerMapping, HubspotCredentials } = await acmeModels();
  await OwnerMapping.init();
  await OwnerMapping.createIndexes();
  // Token vencido: el adaptador debe renovarlo con el servicio del núcleo.
  await HubspotCredentials.create({ _id: credentialId, accessToken: 'viejo', refreshToken: 'r', expiresAt: new Date('2020-01-01T00:00:00.000Z') });
  const [erick, ana, viejo] = await OwnerMapping.create([
    { hubspotCredentialId: credentialId, hubspotOwnerId: '82929225', hubspotOwnerName: 'Erick', hubspotOwnerEmail: 'e@acme.test', sapOwnerId: '53', sapOwnerId_2: '67', active: true, source: 'hubspot_seed' },
    { hubspotCredentialId: credentialId, hubspotOwnerId: '91000001', hubspotOwnerName: 'Ana', hubspotOwnerEmail: null, sapOwnerId: '113,758,864', sapOwnerName: 'Ana Mora', active: false, source: 'manual' },
    { hubspotCredentialId: credentialId, hubspotOwnerId: '70000000', hubspotOwnerName: 'Ya no está', sapOwnerId: '5', active: true, source: 'manual' },
  ]);
  ids.erick = String(erick._id);
  ids.ana = String(ana._id);
  ids.viejo = String(viejo._id);

  const other = await getPanelTenantModels(OTHER);
  const [otherRow] = await other.OwnerMapping.create([{ hubspotCredentialId: new mongoose.Types.ObjectId(), hubspotOwnerId: '1', sapOwnerId: '1' }]);
  ids.other = String(otherRow._id);

  // Servicio de autenticación real (getAccessToken) con la llamada a HubSpot simulada.
  refreshAccessToken = jest.fn(async (id, tenantModels) => {
    await tenantModels.HubspotCredentials.updateOne({ _id: id }, { $set: { accessToken: 'renovado', expiresAt: new Date('2099-01-01T00:00:00.000Z') } });
    return 'renovado';
  });
  const authService = Object.assign(Object.create(hubspotAuthService), { refreshAccessToken });
  crmOwners = [
    { hubspotOwnerId: '82929225', hubspotOwnerName: 'Erick', hubspotOwnerEmail: 'e@acme.test' },
    { hubspotOwnerId: '91000001', hubspotOwnerName: 'Ana Mora', hubspotOwnerEmail: 'ana@acme.test' },
    { hubspotOwnerId: '93000001', hubspotOwnerName: 'Luis Vega', hubspotOwnerEmail: 'luis@acme.test' },
  ];
  fetchOwners = jest.fn(async () => structuredClone(crmOwners));

  ({ ownerMappingsWrite: useCases } = buildPanelOwnerMappingUseCases({
    crmOwnerDirectory: new HubspotCrmOwnerDirectory({ authService, fetchOwners }),
    ownerSyncAttempts: null,
    logger: { warn: () => {}, error: () => {} },
  }));
}, 120000);

afterAll(async () => {
  await SaaSClient?.deleteMany({});
  await disconnectTenantConnections?.();
  await disconnect?.();
  await mongoServer?.stop();
});

describe('owner mappings edit against MongoDB (plan 12, O2 and O4)', () => {
  it('saves with the version, moves updatedAt and writes the history in the tenant database', async () => {
    const before = await rowOf(ids.erick);

    const result = await useCases.update({
      scope: acmeScope,
      id: ids.erick,
      body: { erpOwnerId: ' 200 , 201 ', erpEmployeeId: '70', expectedUpdatedAt: before.updatedAt.toISOString() },
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ id: ids.erick, erpOwnerId: '200,201', erpEmployeeId: '70', active: true }));
    const after = await rowOf(ids.erick);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(result.data.updatedAt).toBe(after.updatedAt.toISOString());

    const history = await historyIn(ACME);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(expect.objectContaining({
      mappingId: new mongoose.Types.ObjectId(ids.erick),
      crmOwnerId: '82929225',
      action: 'updated',
      changedBy: { userId: 'u1', name: 'Adriana Solís', email: 'admin@acme.test', accountType: 'cliente' },
      changes: [
        { field: 'erpOwnerId', from: '53', to: '200,201' },
        { field: 'erpEmployeeId', from: '67', to: '70' },
      ],
    }));
    expect(history[0].changedAt).toBeInstanceOf(Date);
    expect(await historyIn(OTHER)).toEqual([]);

    const { db } = await getTenantConnection(ACME);
    const indexes = await db.collection('OwnerMappingHistory').indexes();
    expect(indexes.map((index) => index.key)).toEqual(expect.arrayContaining([{ mappingId: 1, changedAt: -1 }, { changedAt: -1 }]));
  });

  it('answers stale_update with an old version and leaves the row as it was', async () => {
    const result = await useCases.update({
      scope: acmeScope,
      id: ids.erick,
      body: { erpOwnerId: '999', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' },
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'STALE_UPDATE' }));
    expect((await rowOf(ids.erick)).sapOwnerId).toBe('200,201');
  });

  it('answers erp_owner_taken from the real unique index', async () => {
    const before = await rowOf(ids.erick);

    const result = await useCases.update({
      scope: staffScope(ACME),
      id: ids.erick,
      body: { erpOwnerId: '113, 758, 864', expectedUpdatedAt: before.updatedAt.toISOString() },
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'ERP_OWNER_TAKEN' }));
    const after = await rowOf(ids.erick);
    expect(after.sapOwnerId).toBe('200,201');
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await historyIn(ACME)).toHaveLength(1);
  });

  it('does not touch updatedAt nor the history when nothing changes', async () => {
    const before = await rowOf(ids.erick);

    const result = await useCases.update({
      scope: acmeScope,
      id: ids.erick,
      body: { erpOwnerId: '200,201', erpEmployeeId: 70, expectedUpdatedAt: before.updatedAt.toISOString() },
    });

    expect(result.ok).toBe(true);
    expect((await rowOf(ids.erick)).updatedAt).toEqual(before.updatedAt);
    expect(await historyIn(ACME)).toHaveLength(1);
  });

  it('never reaches a row of another company', async () => {
    const before = await rowOf(ids.erick);
    const body = { erpOwnerId: '1', expectedUpdatedAt: before.updatedAt.toISOString() };

    expect(await useCases.update({ scope: { user: otherAdmin }, id: ids.erick, body })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(await useCases.update({ scope: acmeScope, id: ids.other, body })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect((await rowOf(ids.erick)).sapOwnerId).toBe('200,201');
  });
});

describe('owner mappings sync against MongoDB (plan 12, O3)', () => {
  it('renews the token, inserts the missing owners and refreshes names without moving updatedAt', async () => {
    const anaBefore = await rowOf(ids.ana);

    const result = await useCases.sync({ scope: acmeScope });

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchOwners).toHaveBeenCalledWith('renovado');
    expect(result).toEqual({ ok: true, data: { added: 1, updated: 1, total: 4 } });

    const { OwnerMapping } = await acmeModels();
    const luis = await OwnerMapping.findOne({ hubspotOwnerId: '93000001' }).lean();
    expect(luis).toEqual(expect.objectContaining({
      hubspotOwnerName: 'Luis Vega',
      hubspotOwnerEmail: 'luis@acme.test',
      sapOwnerId: null,
      sapOwnerId_2: null,
      sapOwnerName: null,
      active: true,
      source: 'hubspot_seed',
    }));
    expect(String(luis.hubspotCredentialId)).toBe(String(credentialId));

    const anaAfter = await rowOf(ids.ana);
    expect(anaAfter).toEqual({ ...anaBefore, hubspotOwnerName: 'Ana Mora', hubspotOwnerEmail: 'ana@acme.test' });
    expect(anaAfter.updatedAt).toEqual(anaBefore.updatedAt);

    const created = (await historyIn(ACME)).filter((entry) => entry.action === 'synced_created');
    expect(created).toEqual([expect.objectContaining({ mappingId: luis._id, crmOwnerId: '93000001', changes: [] })]);
  });

  it('is idempotent, uses the renewed token and never deletes rows missing from the CRM', async () => {
    const result = await useCases.sync({ scope: staffScope(ACME) });

    expect(result).toEqual({ ok: true, data: { added: 0, updated: 0, total: 4 } });
    // El token renovado sigue vigente: no se vuelve a renovar (clearMocks limpia las llamadas).
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchOwners).toHaveBeenLastCalledWith('renovado');
    expect(await rowOf(ids.viejo)).toEqual(expect.objectContaining({ sapOwnerId: '5', active: true, source: 'manual' }));
  });

  it('answers crm_unavailable when the CRM fails and inserts nothing for that credential', async () => {
    fetchOwners.mockRejectedValueOnce(new Error('Request failed with status code 503'));
    crmOwners.push({ hubspotOwnerId: '94000000', hubspotOwnerName: 'Nuevo', hubspotOwnerEmail: null });

    const result = await useCases.sync({ scope: acmeScope });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'CRM_UNAVAILABLE' }));
    const { OwnerMapping } = await acmeModels();
    expect(await OwnerMapping.countDocuments({})).toBe(4);
  });

  it('answers crm_unavailable for a company without CRM credential', async () => {
    expect(await useCases.sync({ scope: { user: otherAdmin } })).toEqual(expect.objectContaining({ ok: false, reason: 'CRM_UNAVAILABLE' }));
  });
});
