import { jest } from '@jest/globals';

async function importCompositionWithMocks({
  SapSyncDataAdapter = class {
    fetchData() {}
  },
} = {}) {
  jest.resetModules();

  jest.unstable_mockModule('../../../src/infrastructure/sap/SapSyncDataAdapter.js', () => ({
    default: SapSyncDataAdapter,
  }));
  jest.unstable_mockModule('../../../src/infrastructure/repositories/MappingSyncRepository.js', () => ({
    default: class {
      mapRecords() {}
      ensureDefaultMappings() {}
      findMappings() {}
    },
  }));
  jest.unstable_mockModule('../../../src/infrastructure/hubspot/HubspotSyncAdapter.js', () => ({
    default: class {
      send() {}
    },
  }));
  jest.unstable_mockModule('../../../src/infrastructure/database/repositories/MongooseSyncLogRepository.js', () => ({
    default: class {
      start() {}
      finish() {}
    },
  }));
  jest.unstable_mockModule('../../../src/infrastructure/database/repositories/MongooseClientConfigRepository.js', () => ({
    default: class {
      findById() {}
      markSyncSucceeded() {}
      markSyncFailed() {}
    },
  }));
  jest.unstable_mockModule('../../../src/infrastructure/database/repositories/MongooseHubspotCredentialRepository.js', () => ({
    default: class {
      findByClientConfig() {}
      findById() {}
    },
  }));
  jest.unstable_mockModule('../../../src/infrastructure/config/ProductSyncStrategyConfigRepository.js', () => ({
    default: class {
      getProductSyncStrategyConfig() {}
    },
  }));
  jest.unstable_mockModule('../../../src/infrastructure/database/repositories/MongooseSapSyncTenantRepository.js', () => ({
    default: class {},
  }));
  jest.unstable_mockModule('../../../src/infrastructure/locks/TenantSapSyncLockAdapter.js', () => ({
    default: class {},
  }));
  jest.unstable_mockModule('../../../src/infrastructure/scheduler/SapSyncAdminAdapter.js', () => ({
    default: {},
  }));
  jest.unstable_mockModule('../../../src/composition/hubspot-sync.composition.js', () => ({
    buildSendMappedItemsToHubspot: () => ({ execute: jest.fn() }),
  }));

  return import('../../../src/composition/sap-sync.composition.js');
}

describe('sap-sync composition', () => {
  it('builds the SAP sync use case when all adapters satisfy their ports', async () => {
    const { buildSyncSapConfigToHubspot } = await importCompositionWithMocks();

    const useCase = buildSyncSapConfigToHubspot();

    expect(useCase).toEqual(expect.objectContaining({
      sapDataSource: expect.any(Object),
      mappingRepository: expect.any(Object),
      hubspotSyncTarget: expect.any(Object),
      syncLogRepository: expect.any(Object),
      clientConfigRepository: expect.any(Object),
      hubspotCredentialRepository: expect.any(Object),
    }));
  });

  it('fails clearly when an adapter misses a required port method', async () => {
    const { buildSyncSapConfigToHubspot } = await importCompositionWithMocks({
      SapSyncDataAdapter: class {},
    });

    expect(() => buildSyncSapConfigToHubspot()).toThrow(
      'SapDataSourcePort missing methods: fetchData'
    );
  });
});
