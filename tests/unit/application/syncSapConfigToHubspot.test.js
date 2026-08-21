import { jest } from '@jest/globals';
import SyncSapConfigToHubspot from '../../../src/application/use-cases/SyncSapConfigToHubspot.js';

function createConfig(overrides = {}) {
  return {
    id: 'cfg-1',
    hubspotCredentialId: 'cred-1',
    objectType: 'contact',
    intervalMinutes: 10,
    ...overrides,
  };
}

describe('SyncSapConfigToHubspot', () => {
  it('fetches SAP data, maps records and sends them to HubSpot', async () => {
    const syncLog = { _id: 'log-1' };
    const config = createConfig();
    const tenantContext = { tenantKey: 'tenant-a', tenantModels: {} };
    const sapDataSource = {
      fetchData: jest.fn().mockResolvedValue([{ CardCode: 'C1' }]),
    };
    const mappingRepository = {
      ensureDefaultMappings: jest.fn().mockResolvedValue([]),
      findMappings: jest.fn().mockResolvedValue([{ sourceField: 'CardCode', targetField: 'idsap' }]),
      mapRecords: jest.fn().mockResolvedValue([{ properties: { idsap: 'C1' } }]),
    };
    const hubspotSyncTarget = {
      send: jest.fn().mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0 }),
    };
    const syncLogRepository = {
      start: jest.fn().mockResolvedValue(syncLog),
      finish: jest.fn().mockResolvedValue(null),
    };
    const clientConfigRepository = {
      findById: jest.fn(),
      markSyncSucceeded: jest.fn().mockResolvedValue(null),
      markSyncFailed: jest.fn(),
    };
    const hubspotCredentialRepository = {
      findByClientConfig: jest.fn().mockResolvedValue({ _id: 'cred-1' }),
      findById: jest.fn(),
    };
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource,
      mappingRepository,
      hubspotSyncTarget,
      syncLogRepository,
      clientConfigRepository,
      hubspotCredentialRepository,
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    const result = await useCase.execute({ config, tenantContext });

    expect(syncLogRepository.start).toHaveBeenCalledWith({
      tenantContext,
      clientConfigId: 'cfg-1',
      objectType: 'contact',
      startedAt: new Date('2026-05-05T00:00:00.000Z'),
    });
    expect(hubspotCredentialRepository.findByClientConfig).toHaveBeenCalledWith({
      tenantContext,
      clientConfig: config,
    });
    expect(mappingRepository.ensureDefaultMappings).toHaveBeenCalledWith({
      tenantContext,
      hubspotCredentialId: 'cred-1',
      objectType: 'contact',
      clientConfig: config,
    });
    expect(mappingRepository.findMappings).toHaveBeenCalledWith({
      tenantContext,
      hubspotCredentialId: 'cred-1',
      objectType: 'contact',
      sourceContext: 'businessPartner',
    });
    expect(sapDataSource.fetchData).toHaveBeenCalledWith(expect.objectContaining({
      clientConfigId: 'cfg-1',
      clientConfig: config,
      tenantContext,
      fetchOptions: expect.objectContaining({
        // 'contact' siempre inyecta ContactEmployees en el $select (no depende
        // de businessPartnerCreationConfigRepository, que este test no provee) —
        // ver src/domain/business-partners/contact-employees-select.service.js.
        mappings: [
          { sourceField: 'CardCode', targetField: 'idsap' },
          {
            sourceField: 'ContactEmployees',
            targetField: null,
            objectType: 'contact',
            sourceContext: 'businessPartner',
            includeInServiceLayerSelect: true,
            isActive: true,
          },
        ],
      }),
    }));
    expect(mappingRepository.mapRecords).toHaveBeenCalledWith({
      sapRecords: [{ CardCode: 'C1' }],
      hubspotCredentialId: 'cred-1',
      objectType: 'contact',
      tenantContext,
    });
    expect(hubspotSyncTarget.send).toHaveBeenCalledWith(expect.objectContaining({
      mappedRecords: [{ properties: { idsap: 'C1' }, rawSapData: { CardCode: 'C1' } }],
      config,
      objectType: 'contact',
      tenantContext,
    }));
    expect(syncLogRepository.finish).toHaveBeenLastCalledWith(syncLog, expect.objectContaining({
      status: 'completed',
      recordsProcessed: 1,
      sent: 1,
      failed: 0,
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'completed',
      metrics: {
        recordsProcessed: 1,
        hubspotSent: 1,
        hubspotFailed: 0,
        hubspotCreated: 1,
        hubspotUpdated: 0,
        // Un flujo que no descarta nada igual reporta el par en cero: el
        // SyncLog persiste estos campos tal cual y no deben quedar undefined.
        hubspotSkipped: 0,
        hubspotSkippedReasons: [],
        hubspotErrors: [],
      },
    }));
    expect(clientConfigRepository.markSyncSucceeded).toHaveBeenCalledWith({
      tenantContext,
      configId: 'cfg-1',
      lastRun: new Date('2026-05-05T00:00:00.000Z'),
    });
  });

  it('records an errored sync when HubSpot credentials are missing', async () => {
    const syncLog = { _id: 'log-1' };
    const config = createConfig();
    const tenantContext = { tenantModels: {} };
    const syncLogRepository = {
      start: jest.fn().mockResolvedValue(syncLog),
      finish: jest.fn().mockResolvedValue(null),
    };
    const clientConfigRepository = {
      findById: jest.fn(),
      markSyncSucceeded: jest.fn(),
      markSyncFailed: jest.fn(),
    };
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: { fetchData: jest.fn().mockResolvedValue([{ CardCode: 'C1' }]) },
      mappingRepository: {
        ensureDefaultMappings: jest.fn().mockResolvedValue([]),
        findMappings: jest.fn().mockResolvedValue([]),
        mapRecords: jest.fn(),
      },
      hubspotSyncTarget: { send: jest.fn() },
      syncLogRepository,
      clientConfigRepository,
      hubspotCredentialRepository: {
        findByClientConfig: jest.fn().mockResolvedValue(null),
        findById: jest.fn(),
      },
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    const result = await useCase.execute({ config, tenantContext });

    expect(syncLogRepository.finish).toHaveBeenCalledWith(syncLog, expect.objectContaining({
      status: 'errored',
      errorMessage: 'No HubSpot credentials assigned to this clientConfig',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'errored',
      metrics: expect.objectContaining({
        recordsProcessed: 0,
        hubspotCreated: 0,
        hubspotUpdated: 0,
      }),
    }));
  });

  it('uses configured product sync strategy only for product syncs', async () => {
    const syncLog = { _id: 'log-1' };
    const config = createConfig({ objectType: 'product' });
    const tenantContext = { tenantKey: 'tenant-a', tenantModels: {} };
    const productSyncConfig = { strategy: 'oneToMany_Product' };
    const productStrategy = {
      execute: jest.fn().mockResolvedValue({
        sent: 2,
        failed: 0,
        created: 1,
        updated: 1,
        recordsProcessed: 2,
      }),
    };
    const productSyncConfigRepository = {
      getProductSyncStrategyConfig: jest.fn().mockResolvedValue(productSyncConfig),
    };
    const productSyncStrategyFactory = {
      getStrategy: jest.fn().mockReturnValue(productStrategy),
    };
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: {
        fetchData: jest.fn().mockResolvedValue([{ ItemCode: 'SKU-1' }]),
      },
      mappingRepository: {
        ensureDefaultMappings: jest.fn().mockResolvedValue([]),
        findMappings: jest.fn().mockResolvedValue([{ sourceField: 'ItemCode', targetField: 'hs_sku' }]),
        mapRecords: jest.fn().mockResolvedValue([{ properties: { hs_sku: 'SKU-1' } }]),
      },
      hubspotSyncTarget: {
        send: jest.fn(),
      },
      syncLogRepository: {
        start: jest.fn().mockResolvedValue(syncLog),
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
      productSyncConfigRepository,
      productSyncStrategyFactory,
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    const result = await useCase.execute({ config, tenantContext });

    expect(productSyncConfigRepository.getProductSyncStrategyConfig).toHaveBeenCalledWith({
      tenantContext,
    });
    expect(productSyncStrategyFactory.getStrategy).toHaveBeenCalledWith('oneToMany_Product');
    expect(productStrategy.execute).toHaveBeenCalledWith(expect.objectContaining({
      mappedRecords: [{ properties: { hs_sku: 'SKU-1' }, rawSapData: { ItemCode: 'SKU-1' } }],
      objectType: 'product',
      strategyConfig: productSyncConfig,
    }));
    expect(result.metrics).toEqual(expect.objectContaining({
      recordsProcessed: 2,
      hubspotCreated: 1,
      hubspotUpdated: 1,
    }));
  });

  it('passes clientConfigId and syncLogId to the warehouse stock enricher', async () => {
    const config = createConfig({ objectType: 'product' });
    const tenantContext = { tenantKey: 'tenant-a', tenantModels: {} };
    const warehouseStockEnricher = { enrich: jest.fn().mockResolvedValue(undefined) };

    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: { fetchData: jest.fn().mockResolvedValue([{ ItemCode: 'P1' }]) },
      mappingRepository: {
        ensureDefaultMappings: jest.fn().mockResolvedValue([]),
        findMappings: jest.fn().mockResolvedValue([{ sourceField: 'ItemCode', targetField: 'idsap' }]),
        mapRecords: jest.fn().mockResolvedValue([{ properties: { idsap: 'P1' } }]),
      },
      hubspotSyncTarget: {
        send: jest.fn().mockResolvedValue({ sent: 1, failed: 0, created: 1, updated: 0 }),
      },
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
      warehouseStockEnricher,
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    await useCase.execute({ config, tenantContext });

    // Sin estos dos, el SyncWarning se escribe huerfano: sin corrida y sin
    // tenant al que atribuirlo.
    expect(warehouseStockEnricher.enrich).toHaveBeenCalledWith(expect.objectContaining({
      objectType: 'product',
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    }));
  });

  describe('enrichRecordsWithDiscounts', () => {
    // El grupo real del tenant noelito: vigente, para todos los socios, y con
    // línea sólo para OTRO artículo.
    const ACTIVE_GROUP = {
      AbsEntry: 1,
      Type: 'dgt_AllBPs',
      ObjectCode: '0',
      Active: 'tYES',
      ValidFrom: '2026-08-10T00:00:00Z',
      ValidTo: '2026-08-31T00:00:00Z',
      DiscountGroupLineCollection: [
        { ObjectType: 'dgboItems', ObjectCode: 'A10020139', Discount: 15 },
      ],
    };

    function buildUseCase({ discountGroups = [ACTIVE_GROUP], isRequired = true } = {}) {
      return new SyncSapConfigToHubspot({
        discountConfigRepository: {
          resolveDiscountConfig: jest.fn().mockResolvedValue({
            isRequired,
            fieldMappings: { Discount: 'hs_discount_percentage' },
          }),
        },
        sapDiscountClient: {
          fetchActiveDiscountGroups: jest.fn().mockResolvedValue(discountGroups),
        },
        dateProvider: () => new Date('2026-08-19T18:00:00.000Z'),
      });
    }

    function buildTenantContext() {
      return {
        tenantModels: {
          SapCredentials: {
            find: () => ({ lean: async () => [{ serviceLayerBaseUrl: 'https://sap.example' }] }),
          },
        },
      };
    }

    async function enrich(useCase, mappedRecords) {
      await useCase.enrichRecordsWithDiscounts({
        mappedRecords,
        objectType: 'product',
        config: { tenantKey: 'noelito' },
        tenantContext: buildTenantContext(),
      });
    }

    it('resolves 0 when SAP has no discount for the product, so a stale HubSpot value gets cleared', async () => {
      const mappedRecords = [{ rawSapData: { ItemCode: 'P42010005', ItemsGroupCode: 106 } }];

      await enrich(buildUseCase(), mappedRecords);

      expect(mappedRecords[0].rawSapData._resolvedDiscount).toBe(0);
    });

    it('keeps the real discount when SAP does have one for the product', async () => {
      const mappedRecords = [{ rawSapData: { ItemCode: 'A10020139', ItemsGroupCode: 100 } }];

      await enrich(buildUseCase(), mappedRecords);

      expect(mappedRecords[0].rawSapData._resolvedDiscount).toBe(15);
    });

    it('leaves the key absent when the tenant has discounts disabled, so HubSpot is not touched', async () => {
      const mappedRecords = [{ rawSapData: { ItemCode: 'P42010005', ItemsGroupCode: 106 } }];

      await enrich(buildUseCase({ isRequired: false }), mappedRecords);

      expect(mappedRecords[0].rawSapData).not.toHaveProperty('_resolvedDiscount');
    });
  });
});

// El desglose nace en el handler de facturas y tiene que llegar entero hasta el
// SyncLog: si se queda en el objeto de metrics, no queda registro en la base.
describe('SyncSapConfigToHubspot skip reporting', () => {
  function buildInvoiceRun(hubspotResult) {
    const syncLog = { _id: 'log-1' };
    const syncLogRepository = {
      start: jest.fn().mockResolvedValue(syncLog),
      finish: jest.fn().mockResolvedValue(null),
    };
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: {
        fetchData: jest.fn().mockResolvedValue([{ NumAtCard: 'HS-DEAL-1' }, { NumAtCard: 'OC-9' }]),
      },
      mappingRepository: {
        ensureDefaultMappings: jest.fn().mockResolvedValue([]),
        findMappings: jest.fn().mockResolvedValue([{ sourceField: 'NumAtCard', targetField: 'num_at_card' }]),
        mapRecords: jest.fn().mockResolvedValue([{ properties: {} }, { properties: {} }]),
      },
      hubspotSyncTarget: { send: jest.fn().mockResolvedValue(hubspotResult) },
      syncLogRepository,
      clientConfigRepository: {
        findById: jest.fn(),
        markSyncSucceeded: jest.fn().mockResolvedValue(null),
        markSyncFailed: jest.fn(),
      },
      hubspotCredentialRepository: {
        findByClientConfig: jest.fn().mockResolvedValue({ _id: 'cred-1' }),
        findById: jest.fn(),
      },
      dateProvider: () => new Date('2026-08-19T18:06:05.571Z'),
    });

    return { useCase, syncLog, syncLogRepository };
  }

  it('writes updated, skipped and the reason breakdown into the sync log', async () => {
    const { useCase, syncLog, syncLogRepository } = buildInvoiceRun({
      sent: 1,
      failed: 0,
      created: 0,
      updated: 1,
      skipped: 1,
      skippedReasons: [{ reason: 'no_deal_in_num_at_card', count: 1 }],
    });

    const result = await useCase.execute({
      config: createConfig({ objectType: 'invoice' }),
      tenantContext: { tenantKey: 'tenant-a', tenantModels: {} },
    });

    expect(syncLogRepository.finish).toHaveBeenLastCalledWith(syncLog, expect.objectContaining({
      status: 'completed',
      recordsProcessed: 2,
      sent: 1,
      updated: 1,
      skipped: 1,
      skippedReasons: [{ reason: 'no_deal_in_num_at_card', count: 1 }],
    }));
    expect(result.metrics).toEqual(expect.objectContaining({
      hubspotUpdated: 1,
      hubspotSkipped: 1,
      hubspotSkippedReasons: [{ reason: 'no_deal_in_num_at_card', count: 1 }],
    }));
  });

  // Los flujos que no descartan nada (contactos, empresas, productos) no
  // devuelven estas claves y deben seguir escribiendo ceros, no undefined.
  it('falls back to zero for the flows that never skip', async () => {
    const { useCase, syncLog, syncLogRepository } = buildInvoiceRun({
      sent: 2, failed: 0, created: 2, updated: 0,
    });

    await useCase.execute({
      config: createConfig(),
      tenantContext: { tenantKey: 'tenant-a', tenantModels: {} },
    });

    expect(syncLogRepository.finish).toHaveBeenLastCalledWith(syncLog, expect.objectContaining({
      skipped: 0,
      skippedReasons: [],
    }));
  });
});
