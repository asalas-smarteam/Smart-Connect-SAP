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
        mappings: [{ sourceField: 'CardCode', targetField: 'idsap' }],
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
});
