import { jest } from '@jest/globals';
import SyncSapConfigToHubspot from '../../../src/application/use-cases/SyncSapConfigToHubspot.js';
import { normalizeAddressSyncConfig } from '../../../src/domain/business-partners/address-sync.service.js';

const ENABLED = normalizeAddressSyncConfig({
  required: true,
  addresses: [
    { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
    { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' },
  ],
});

const REQUIRED_BUT_EMPTY = { required: true, addresses: [] };
const OFF = { required: false, addresses: [] };

const BASE_MAPPING = {
  sourceField: 'CardCode',
  targetField: 'idsap',
  sourceContext: 'businessPartner',
  includeInServiceLayerSelect: true,
  isActive: true,
};

function buildHarness({
  objectType = 'company',
  addressConfig = ENABLED,
  withRepository = true,
  withEnricher = true,
  repositoryError = null,
} = {}) {
  const config = { id: 'cfg-1', hubspotCredentialId: 'cred-1', objectType, intervalMinutes: 10 };
  const tenantContext = { tenantKey: 'tenant-a', tenantModels: { marker: 'tenant-models' } };
  const rawData = [{ CardCode: 'C1', BPAddresses: [] }];

  const sapDataSource = { fetchData: jest.fn().mockResolvedValue(rawData) };
  const mappingRepository = {
    ensureDefaultMappings: jest.fn().mockResolvedValue([]),
    findMappings: jest.fn().mockResolvedValue([BASE_MAPPING]),
    mapRecords: jest.fn().mockResolvedValue([{ properties: { idsap: 'C1' } }]),
  };
  const hubspotSyncTarget = { send: jest.fn().mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0 }) };
  const addressSyncConfigRepository = {
    getAddressSyncConfig: repositoryError
      ? jest.fn().mockRejectedValue(repositoryError)
      : jest.fn().mockResolvedValue(addressConfig),
  };
  const addressSyncEnricher = { enrich: jest.fn().mockResolvedValue(undefined) };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };

  const useCase = new SyncSapConfigToHubspot({
    sapDataSource,
    mappingRepository,
    hubspotSyncTarget,
    syncLogRepository: {
      start: jest.fn().mockResolvedValue({ _id: 'log-1' }),
      finish: jest.fn().mockResolvedValue(null),
    },
    clientConfigRepository: {
      findById: jest.fn(),
      markSyncSucceeded: jest.fn().mockResolvedValue(null),
      markSyncFailed: jest.fn(),
    },
    hubspotCredentialRepository: {
      findByClientConfig: jest.fn().mockResolvedValue({ _id: 'cred-1' }),
      findById: jest.fn(),
    },
    ...(withRepository ? { addressSyncConfigRepository } : {}),
    ...(withEnricher ? { addressSyncEnricher } : {}),
    logger,
    dateProvider: () => new Date('2026-10-13T00:00:00.000Z'),
  });

  return {
    run: () => useCase.execute({ config, tenantContext }),
    tenantContext,
    sapDataSource,
    mappingRepository,
    hubspotSyncTarget,
    addressSyncConfigRepository,
    addressSyncEnricher,
    logger,
  };
}

function selectedFields(sapDataSource) {
  return sapDataSource.fetchData.mock.calls[0][0].fetchOptions.mappings.map((mapping) => mapping.sourceField);
}

function warningCodes(logger) {
  return logger.warn.mock.calls.map(([payload]) => payload?.code).filter(Boolean);
}

describe('SyncSapConfigToHubspot with the address sync (requireAddress)', () => {
  describe('the request to SAP', () => {
    it.each(['company', 'contact'])('asks for BPAddresses when the sync is on, for a %s', async (objectType) => {
      const harness = buildHarness({ objectType });

      await harness.run();

      expect(selectedFields(harness.sapDataSource)).toContain('BPAddresses');
      expect(selectedFields(harness.sapDataSource).filter((field) => field === 'BPAddresses')).toHaveLength(1);
    });

    it.each(['product', 'deal'])('does not ask for it for a %s, and does not even read the config', async (objectType) => {
      const harness = buildHarness({ objectType });

      await harness.run();

      expect(selectedFields(harness.sapDataSource)).not.toContain('BPAddresses');
      expect(harness.addressSyncConfigRepository.getAddressSyncConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['required is false', OFF],
      ['required but there is nothing to write', REQUIRED_BUT_EMPTY],
      ['the config is null', null],
    ])('does not ask for it when %s', async (_label, addressConfig) => {
      const harness = buildHarness({ addressConfig });

      await harness.run();

      expect(selectedFields(harness.sapDataSource)).not.toContain('BPAddresses');
    });

    it('leaves the request as it was when the repository is not injected', async () => {
      const harness = buildHarness({ withRepository: false });

      await harness.run();

      expect(selectedFields(harness.sapDataSource)).toEqual(['CardCode']);
    });

    it('reads the config once for the whole run, shared by the request and the warning', async () => {
      const harness = buildHarness({ addressConfig: REQUIRED_BUT_EMPTY });

      await harness.run();

      expect(harness.addressSyncConfigRepository.getAddressSyncConfig).toHaveBeenCalledTimes(1);
      expect(harness.addressSyncConfigRepository.getAddressSyncConfig)
        .toHaveBeenCalledWith({ tenantModels: harness.tenantContext.tenantModels });
    });
  });

  describe('the enricher', () => {
    it.each(['company', 'contact'])('runs after mapRecords and before the send, for a %s', async (objectType) => {
      const harness = buildHarness({ objectType });

      await harness.run();

      expect(harness.addressSyncEnricher.enrich).toHaveBeenCalledTimes(1);
      expect(harness.addressSyncEnricher.enrich).toHaveBeenCalledWith(expect.objectContaining({
        objectType,
        tenantModels: harness.tenantContext.tenantModels,
        mappedRecords: [expect.objectContaining({
          properties: { idsap: 'C1' },
          rawSapData: expect.objectContaining({ CardCode: 'C1' }),
        })],
      }));

      const [enrichOrder] = harness.addressSyncEnricher.enrich.mock.invocationCallOrder;
      const [mapOrder] = harness.mappingRepository.mapRecords.mock.invocationCallOrder;
      const [sendOrder] = harness.hubspotSyncTarget.send.mock.invocationCallOrder;

      expect(enrichOrder).toBeGreaterThan(mapOrder);
      expect(enrichOrder).toBeLessThan(sendOrder);
    });

    it('is optional: a run without it still completes and sends', async () => {
      const harness = buildHarness({ withEnricher: false });

      const result = await harness.run();

      expect(result.ok).toBe(true);
      expect(harness.hubspotSyncTarget.send).toHaveBeenCalledTimes(1);
    });
  });

  // The old placeholder said "not implemented" for any tenant that set required: true. The
  // feature exists now, so the only thing worth reporting is a tenant that asked for it and gave
  // nothing valid to write (or is not on B1, where the repository clears addresses).
  describe('the warning', () => {
    it('reports a tenant that asked for the sync and has nothing valid to write', async () => {
      const harness = buildHarness({ addressConfig: REQUIRED_BUT_EMPTY });

      await harness.run();

      expect(warningCodes(harness.logger)).toEqual(['ADDRESS_SYNC_MISCONFIGURED']);
      expect(harness.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        code: 'ADDRESS_SYNC_MISCONFIGURED',
        objectType: 'company',
      }));
    });

    it.each([
      ['the sync is on and valid', ENABLED],
      ['the sync is off', OFF],
      ['the config is null', null],
    ])('says nothing when %s', async (_label, addressConfig) => {
      const harness = buildHarness({ addressConfig });

      await harness.run();

      expect(warningCodes(harness.logger)).toEqual([]);
    });

    it('never emits the old "not implemented" code', async () => {
      const harness = buildHarness({ addressConfig: REQUIRED_BUT_EMPTY });

      await harness.run();

      expect(warningCodes(harness.logger)).not.toContain('ADDRESS_SYNC_NOT_IMPLEMENTED');
    });

    it('does not stop the sync: the records are still sent', async () => {
      const harness = buildHarness({ addressConfig: REQUIRED_BUT_EMPTY });

      const result = await harness.run();

      expect(result.ok).toBe(true);
      expect(harness.hubspotSyncTarget.send).toHaveBeenCalledTimes(1);
    });

    it('does not warn for a product sync', async () => {
      const harness = buildHarness({ objectType: 'product', addressConfig: REQUIRED_BUT_EMPTY });

      await harness.run();

      expect(warningCodes(harness.logger)).toEqual([]);
    });
  });

  // The repository promises never to throw, but a sync that dies because a config could not be
  // read is a worse failure than a sync without addresses, so the use case does not rely on it.
  it('treats a config that cannot be read as the feature being off, and still syncs', async () => {
    const harness = buildHarness({ repositoryError: new Error('mongo caido') });

    const result = await harness.run();

    expect(result.ok).toBe(true);
    expect(selectedFields(harness.sapDataSource)).toEqual(['CardCode']);
    expect(harness.hubspotSyncTarget.send).toHaveBeenCalledTimes(1);

    // Review finding R3-unasserted-config-read-failure-log: the feature goes off with no other sign,
    // so the log is the only thing an operator would see. If it were dropped nothing else would fail.
    expect(harness.logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(harness.logger.error.mock.calls[0])).toContain('mongo caido');
  });
});
