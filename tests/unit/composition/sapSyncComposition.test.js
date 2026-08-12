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
      // Tarea 6: sin esta aserción, borrar el cableado del enricher de
      // PropertiesN dejaría este test (y el de propertiesFlagsEnricherWiring,
      // que solo verifica el adapter en aislamiento) en verde igual.
      // `expect.any(Object)` NO alcanza aquí: typeof null === 'object', y el
      // constructor de SyncSapConfigToHubspot defaultea estas dos props a
      // null, así que `expect.any(Object)` las deja pasar aunque el cableado
      // se borre por completo. objectContaining sí rechaza null (revisa
      // `other === null` antes de mirar las keys), y verificar la forma real
      // (un método que solo el objeto real tiene) evita además el problema de
      // identidad de módulo ESM que tendría un toBeInstanceOf aquí: este
      // archivo importa la composición de forma dinámica después de
      // jest.resetModules(), así que una clase importada de forma estática al
      // tope del archivo podría no ser el mismo registro de módulo.
      propertiesFlagsEnricher: expect.objectContaining({
        enrich: expect.any(Function),
      }),
      businessPartnerCreationConfigRepository: expect.objectContaining({
        getPropertiesFlagsConfig: expect.any(Function),
      }),
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
