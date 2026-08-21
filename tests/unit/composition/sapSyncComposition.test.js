import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

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

  const composition = await import('../../../src/composition/sap-sync.composition.js');
  // El logger real se importa DESPUÉS de la composición y dentro de la misma
  // ventana de registro de módulos (post-resetModules) para que sea exactamente
  // la misma instancia que resolvió la composición. Un import estático al tope
  // del archivo pertenecería a otro registro y rompería el toBe por identidad
  // de módulo ESM, no por un cableado mal hecho.
  const { default: realLogger } = await import(
    '../../../src/infrastructure/logger/logger.adapter.js'
  );

  return { ...composition, realLogger };
}

describe('sap-sync composition', () => {
  it('builds the SAP sync use case when all adapters satisfy their ports', async () => {
    const { buildSyncSapConfigToHubspot, realLogger } = await importCompositionWithMocks();

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
      // Tarea 9 (y revisión final): estas dos props se agregaron DESPUÉS de que
      // se escribió el guard de arriba, así que quedaron sin cubrir — el mismo
      // hueco que el guard existe para evitar. Ambas defaultean a algo truthy o
      // a null en el constructor, así que sin aserción propia borrar su
      // cableado no rompe ningún test.
      addressSyncConfigRepository: expect.objectContaining({
        getAddressSyncConfig: expect.any(Function),
      }),
    }));

    // `logger` NO se puede afirmar con objectContaining({ warn, error }): el
    // default del constructor es `console`, que también tiene warn y error, así
    // que ese matcher pasaría con el cableado borrado. Se afirma identidad con
    // la instancia real de winston, que es la aserción más fuerte y barata.
    expect(useCase.logger).toBe(realLogger);
    expect(useCase.logger).not.toBe(console);
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

// Verificacion textual a proposito: un parametro del constructor puede quedar
// sin cablear en composicion y TODOS los tests unitarios siguen verdes, porque
// cada uno inyecta su propio doble. Ya paso tres veces en este repo. Aserciones
// como expect.any(Object) no lo detectan; leer el archivo si.
// La ruta se resuelve contra la ubicacion de ESTE archivo, no contra
// process.cwd(): jest.config.js no fija rootDir, asi que correr jest desde un
// subdirectorio hacia fallar el import con un "archivo inexistente" enganoso.
const source = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../src/composition/sap-sync.composition.js'),
  'utf8'
);

describe('sap-sync composition (verificacion textual del cableado)', () => {
  it('inyecta batchExpiryEnricher en SyncSapConfigToHubspot', () => {
    expect(source).toMatch(/batchExpiryEnricher:\s*assertPort\(/);
  });

  it('construye el adaptador con AMBAS factories y el repositorio de config', () => {
    expect(source).toContain('new BatchExpiryEnrichmentAdapter({');
    expect(source).toMatch(/sourceFactory:\s*batchSourceStrategyFactory/);
    expect(source).toMatch(/projectionFactory:\s*batchProjectionStrategyFactory/);
    expect(source).toMatch(/configRepository:\s*new BatchExpiryConfigRepository\(\)/);
  });

  it('registra la estrategia s4 Y la none en la factory de fuente', () => {
    expect(source).toMatch(/noneStrategy:\s*new NoneBatchSourceStrategy\(\)/);
    expect(source).toMatch(/s4BatchMasterStrategy:\s*new S4BatchMasterStrategy\(\)/);
  });

  it('valida el adaptador contra SapRecordEnricherPort', () => {
    expect(source).toMatch(/BatchExpiryEnrichmentAdapter[\s\S]{0,400}?SapRecordEnricherPort/);
  });

  it('inyecta syncWarningRepository en WarehouseStockEnrichmentAdapter', () => {
    expect(source).toMatch(/import MongooseSyncWarningRepository from/);
    expect(source).toMatch(
      /new WarehouseStockEnrichmentAdapter\(\{[\s\S]{0,400}?syncWarningRepository:\s*new MongooseSyncWarningRepository\(\)/
    );
  });
});
