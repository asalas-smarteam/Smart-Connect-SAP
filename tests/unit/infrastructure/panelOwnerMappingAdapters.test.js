import { jest } from '@jest/globals';
import MongooseOwnerMappingWriter from '../../../src/infrastructure/database/repositories/MongooseOwnerMappingWriter.js';
import HubspotCrmOwnerDirectory from '../../../src/infrastructure/hubspot/HubspotCrmOwnerDirectory.js';
import { getPanelTenantModels } from '../../../src/infrastructure/database/repositories/panelTenantModels.js';
import { ownerMappingHistorySchema } from '../../../src/infrastructure/database/models/panel/OwnerMappingHistory.js';

const TENANT = 'sap_integration_acme';
const ID = '6a6b94a1cd7c01b21aa58d41';
const CREDENTIAL = '6a6b94a1cd7c01b21aa58c98';
const VERSION = new Date('2026-07-03T02:03:51.125Z');

function lean(result) {
  return { lean: jest.fn().mockResolvedValue(result), sort: jest.fn().mockReturnThis() };
}

function duplicateKey() {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

function buildWriter(OwnerMapping = {}, OwnerMappingHistory = {}) {
  const getModels = jest.fn().mockResolvedValue({ OwnerMapping, OwnerMappingHistory, connection: {} });
  return { writer: new MongooseOwnerMappingWriter({ getModels }), getModels };
}

describe('OwnerMappingHistory schema (plan 12, O4)', () => {
  it('never creates the collection or indexes on registration and has no TTL', () => {
    expect(ownerMappingHistorySchema.get('autoIndex')).toBe(false);
    expect(ownerMappingHistorySchema.get('autoCreate')).toBe(false);
    expect(ownerMappingHistorySchema.get('collection')).toBe('OwnerMappingHistory');
    const indexes = ownerMappingHistorySchema.indexes();
    expect(indexes.map(([fields]) => fields)).toEqual([{ mappingId: 1, changedAt: -1 }, { changedAt: -1 }]);
    expect(indexes.some(([, options]) => options?.expireAfterSeconds !== undefined)).toBe(false);
  });

  it('only accepts the two actions and the two editable fields', () => {
    expect(ownerMappingHistorySchema.path('action').enumValues).toEqual(['updated', 'synced_created']);
    expect(ownerMappingHistorySchema.path('changes').schema.path('field').enumValues).toEqual(['erpOwnerId', 'erpEmployeeId']);
  });
});

describe('getPanelTenantModels with the owner mapping models (plan 12)', () => {
  it('registers OwnerMapping, HubspotCredentials and the history only when used, reusing them', async () => {
    const models = {};
    const connection = {
      models,
      model: jest.fn((name) => {
        models[name] = { modelName: name };
        return models[name];
      }),
    };
    const getConnection = jest.fn().mockResolvedValue(connection);

    const first = await getPanelTenantModels(TENANT, { getConnection });
    expect(Object.keys(models).sort()).toEqual(['PanelTicket', 'PanelTicketCounter']);

    expect(first.OwnerMapping.modelName).toBe('OwnerMapping');
    expect(first.HubspotCredentials.modelName).toBe('HubspotCredentials');
    expect(first.OwnerMappingHistory.modelName).toBe('PanelOwnerMappingHistory');
    const second = await getPanelTenantModels(TENANT, { getConnection });
    expect(second.OwnerMapping).toBe(first.OwnerMapping);
    expect(connection.model).toHaveBeenCalledTimes(5);
  });
});

describe('MongooseOwnerMappingWriter', () => {
  it('returns null for malformed ids without opening the tenant', async () => {
    const { writer, getModels } = buildWriter();

    expect(await writer.findById(TENANT, 'abc')).toBeNull();
    expect(await writer.findById(TENANT, { $ne: null })).toBeNull();
    expect(await writer.updateErpCodes(TENANT, '../x', { expectedUpdatedAt: VERSION, set: {} })).toBeNull();
    expect(await writer.listByCredential(TENANT, 'x')).toEqual([]);
    await writer.refreshCrmOwnerData(TENANT, 'x', {});
    expect(getModels).not.toHaveBeenCalled();
  });

  it('reads one row lean', async () => {
    const row = { _id: ID };
    const OwnerMapping = { findById: jest.fn(() => lean(row)) };
    const { writer } = buildWriter(OwnerMapping);

    expect(await writer.findById(TENANT, ID)).toBe(row);
    expect(OwnerMapping.findById).toHaveBeenCalledWith(ID);
  });

  it('updates with the version in the filter, $set and validators', async () => {
    const updated = { _id: ID, sapOwnerId: '1' };
    const OwnerMapping = { findOneAndUpdate: jest.fn().mockResolvedValue(updated) };
    const { writer } = buildWriter(OwnerMapping);

    expect(await writer.updateErpCodes(TENANT, ID, { expectedUpdatedAt: VERSION, set: { sapOwnerId: '1' } })).toBe(updated);
    expect(OwnerMapping.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ID, updatedAt: VERSION },
      { $set: { sapOwnerId: '1' } },
      { new: true, lean: true, runValidators: true }
    );
  });

  it('returns null when the version does not match and throws ERP_OWNER_TAKEN on E11000', async () => {
    const OwnerMapping = { findOneAndUpdate: jest.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(duplicateKey()) };
    const { writer } = buildWriter(OwnerMapping);

    expect(await writer.updateErpCodes(TENANT, ID, { expectedUpdatedAt: VERSION, set: {} })).toBeNull();
    await expect(writer.updateErpCodes(TENANT, ID, { expectedUpdatedAt: VERSION, set: { sapOwnerId: '1' } }))
      .rejects.toMatchObject({ code: 'ERP_OWNER_TAKEN' });
  });

  it('lets other database errors through', async () => {
    const OwnerMapping = { findOneAndUpdate: jest.fn().mockRejectedValue(new Error('down')) };
    const { writer } = buildWriter(OwnerMapping);

    await expect(writer.updateErpCodes(TENANT, ID, { expectedUpdatedAt: VERSION, set: {} })).rejects.toThrow('down');
  });

  it('lists the rows of a credential with only the CRM fields', async () => {
    const OwnerMapping = { find: jest.fn(() => lean([{ _id: ID }])) };
    const { writer } = buildWriter(OwnerMapping);

    expect(await writer.listByCredential(TENANT, CREDENTIAL)).toEqual([{ _id: ID }]);
    expect(OwnerMapping.find).toHaveBeenCalledWith(
      { hubspotCredentialId: CREDENTIAL },
      { _id: 1, hubspotOwnerId: 1, hubspotOwnerName: 1, hubspotOwnerEmail: 1 }
    );
  });

  it('inserts like the seed and answers null on a duplicate key', async () => {
    const OwnerMapping = {
      create: jest.fn()
        .mockResolvedValueOnce({ toObject: () => ({ _id: ID }) })
        .mockRejectedValueOnce(duplicateKey())
        .mockRejectedValueOnce(new Error('down')),
    };
    const { writer } = buildWriter(OwnerMapping);
    const owner = { hubspotCredentialId: CREDENTIAL, hubspotOwnerId: '9', hubspotOwnerName: 'Luis', hubspotOwnerEmail: undefined };

    expect(await writer.insertSeeded(TENANT, owner)).toEqual({ _id: ID });
    expect(OwnerMapping.create).toHaveBeenCalledWith({
      hubspotCredentialId: CREDENTIAL,
      hubspotOwnerId: '9',
      hubspotOwnerName: 'Luis',
      hubspotOwnerEmail: null,
      sapOwnerId: null,
      sapOwnerId_2: null,
      sapOwnerName: null,
      active: true,
      source: 'hubspot_seed',
    });
    expect(await writer.insertSeeded(TENANT, owner)).toBeNull();
    await expect(writer.insertSeeded(TENANT, owner)).rejects.toThrow('down');
  });

  it('refreshes name and email without timestamps and counts every row', async () => {
    const OwnerMapping = { updateOne: jest.fn().mockResolvedValue({}), countDocuments: jest.fn().mockResolvedValue(7) };
    const { writer } = buildWriter(OwnerMapping);

    await writer.refreshCrmOwnerData(TENANT, ID, { hubspotOwnerName: 'Ana', hubspotOwnerEmail: null });

    expect(OwnerMapping.updateOne).toHaveBeenCalledWith(
      { _id: ID },
      { $set: { hubspotOwnerName: 'Ana', hubspotOwnerEmail: null } },
      { timestamps: false }
    );
    expect(await writer.countAll(TENANT)).toBe(7);
    expect(OwnerMapping.countDocuments).toHaveBeenCalledWith({});
  });

  it('creates the history indexes once per tenant and retries after a failure', async () => {
    const OwnerMappingHistory = {
      createIndexes: jest.fn().mockRejectedValueOnce(new Error('index down')).mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({}),
    };
    const { writer } = buildWriter({}, OwnerMappingHistory);
    const entry = { mappingId: ID, action: 'updated', changes: [] };

    await expect(writer.appendHistory(TENANT, entry)).rejects.toThrow('index down');
    await writer.appendHistory(TENANT, entry);
    await writer.appendHistory(TENANT, entry);

    expect(OwnerMappingHistory.createIndexes).toHaveBeenCalledTimes(2);
    expect(OwnerMappingHistory.create).toHaveBeenCalledTimes(2);
    expect(OwnerMappingHistory.create).toHaveBeenCalledWith(entry);
  });
});

describe('HubspotCrmOwnerDirectory', () => {
  function build({ credential = { _id: CREDENTIAL, accessToken: 'secreto', expiresAt: new Date('2099-01-01') } } = {}) {
    const HubspotCredentials = {
      find: jest.fn(() => lean([{ _id: CREDENTIAL }, { _id: '6a6b94a1cd7c01b21aa58c99' }])),
      findById: jest.fn(() => lean(credential)),
    };
    const getModels = jest.fn().mockResolvedValue({ HubspotCredentials });
    const authService = { getAccessToken: jest.fn().mockResolvedValue('token-vigente') };
    const fetchOwners = jest.fn().mockResolvedValue([{ hubspotOwnerId: '1', hubspotOwnerName: 'Ana', hubspotOwnerEmail: null }]);
    const directory = new HubspotCrmOwnerDirectory({ getModels, authService, fetchOwners });
    return { directory, HubspotCredentials, authService, fetchOwners };
  }

  it('lists the CRM credentials of the tenant as ids', async () => {
    const { directory, HubspotCredentials } = build();

    expect(await directory.listCredentials(TENANT)).toEqual([{ id: CREDENTIAL }, { id: '6a6b94a1cd7c01b21aa58c99' }]);
    expect(HubspotCredentials.find).toHaveBeenCalledWith({}, { _id: 1 });
  });

  it('gets the token through the auth service (renews it if expired) and fetches every owner', async () => {
    const { directory, authService, fetchOwners, HubspotCredentials } = build();

    const owners = await directory.fetchOwners(TENANT, CREDENTIAL);

    expect(owners).toEqual([{ hubspotOwnerId: '1', hubspotOwnerName: 'Ana', hubspotOwnerEmail: null }]);
    expect(authService.getAccessToken).toHaveBeenCalledWith(CREDENTIAL, expect.objectContaining({ _id: CREDENTIAL }), { HubspotCredentials });
    expect(fetchOwners).toHaveBeenCalledWith('token-vigente');
  });

  it('throws when the credential is gone, the token cannot be renewed or the CRM fails', async () => {
    const missing = build({ credential: null });
    await expect(missing.directory.fetchOwners(TENANT, CREDENTIAL)).rejects.toThrow('CRM credential not found');

    const expired = build();
    expired.authService.getAccessToken.mockRejectedValue(new Error('Refresh token not found for client configuration'));
    await expect(expired.directory.fetchOwners(TENANT, CREDENTIAL)).rejects.toThrow('Refresh token');
    expect(expired.fetchOwners).not.toHaveBeenCalled();

    const down = build();
    down.fetchOwners.mockRejectedValue(new Error('Request failed with status code 503'));
    await expect(down.directory.fetchOwners(TENANT, CREDENTIAL)).rejects.toThrow('503');
  });
});
