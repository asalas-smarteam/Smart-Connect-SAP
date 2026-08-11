import { jest } from '@jest/globals';
import { WarehouseStockEnrichmentAdapter } from '../../../src/infrastructure/sap/products/WarehouseStockEnrichmentAdapter.js';
import { WAREHOUSE_STOCK_KEY } from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';

function buildRecords(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    properties: {},
    rawSapData: { Product: String(1000 + index) },
  }));
}

function buildConfigRepository(config) {
  return { getWarehouseStockConfig: jest.fn().mockResolvedValue(config) };
}

function buildTenantModels(credentials = [{ serviceLayerBaseUrl: 'https://s4' }]) {
  return {
    SapCredentials: { find: () => ({ lean: async () => credentials }) },
  };
}

const silentLogger = { warn: jest.fn(), error: jest.fn() };

describe('WarehouseStockEnrichmentAdapter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is a no-op for non-product syncs', async () => {
    const configRepository = buildConfigRepository({ strategyName: 'x', rawFields: [], rawExclusions: [] });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn() },
      configRepository,
      logger: silentLogger,
    });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels: buildTenantModels() });

    expect(configRepository.getWarehouseStockConfig).not.toHaveBeenCalled();
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toBeUndefined();
  });

  it('is a no-op without tenantModels', async () => {
    const configRepository = buildConfigRepository({});
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn() },
      configRepository,
      logger: silentLogger,
    });

    await adapter.enrich({ mappedRecords: buildRecords(), objectType: 'product', tenantModels: null });

    expect(configRepository.getWarehouseStockConfig).not.toHaveBeenCalled();
  });

  it('sets {} on every record when no fields are configured', async () => {
    const strategy = {
      normalizeFields: jest.fn().mockReturnValue([]),
      normalizeExclusions: jest.fn().mockReturnValue([]),
      requiresRemoteFetch: jest.fn().mockReturnValue(true),
    };
    const configRepository = buildConfigRepository({ strategyName: 's4', rawFields: null, rawExclusions: null });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository,
      logger: silentLogger,
    });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() });

    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({});
    expect(records[1].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({});
  });

  it('does not touch SapCredentials for a strategy that does not require a remote fetch (B1)', async () => {
    const fields = [{ propertyName: 'a01_stock', plant: null, storageLocation: null, stockTypes: ['01'] }];
    const strategy = {
      normalizeFields: jest.fn().mockReturnValue(fields),
      normalizeExclusions: jest.fn().mockReturnValue([]),
      requiresRemoteFetch: jest.fn().mockReturnValue(false),
      buildProperties: jest.fn().mockReturnValue({ a01_stock: 5 }),
    };
    const tenantModels = buildTenantModels();
    tenantModels.SapCredentials.find = jest.fn();
    const configRepository = buildConfigRepository({ strategyName: 'b1', rawFields: [{}], rawExclusions: [] });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(tenantModels.SapCredentials.find).not.toHaveBeenCalled();
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });

  it('resolves via the SAP transport for a strategy that requires a remote fetch (S/4)', async () => {
    const fields = [{ propertyName: 'mqgt_0008_stock', plant: 'MQGT', storageLocation: '0008', stockTypes: ['01'] }];
    const targets = [{ plant: 'MQGT', storageLocations: ['0008'] }];
    const rawRows = [{ Material: '1000' }];
    const index = new Map([['1000', [{ plant: 'MQGT', storageLocation: '0008', stockType: '01', quantity: 12 }]]]);

    const strategy = {
      normalizeFields: jest.fn().mockReturnValue(fields),
      normalizeExclusions: jest.fn().mockReturnValue([]),
      requiresRemoteFetch: jest.fn().mockReturnValue(true),
      buildQueryTargets: jest.fn().mockReturnValue(targets),
      buildIndex: jest.fn().mockReturnValue(index),
      buildProperties: jest.fn(({ record }) => ({
        mqgt_0008_stock: record.rawSapData.Product === '1000' ? 12 : 0,
      })),
    };
    const resolver = { fetchStockRows: jest.fn().mockResolvedValue(rawRows) };
    const resolverFactory = jest.fn().mockReturnValue(resolver);
    const configRepository = buildConfigRepository({ strategyName: 's4', rawFields: [{}], rawExclusions: [] });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository,
      resolverFactory,
      logger: silentLogger,
    });
    const records = buildRecords(2);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() });

    expect(resolverFactory).toHaveBeenCalledWith(expect.objectContaining({ serviceLayerBaseUrl: 'https://s4' }));
    expect(resolver.fetchStockRows).toHaveBeenCalledWith(targets);
    expect(strategy.buildIndex).toHaveBeenCalledWith(rawRows, { exclusions: [] });
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ mqgt_0008_stock: 12 });
    expect(records[1].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ mqgt_0008_stock: 0 });
  });

  it('sets {} and skips the fetch when the tenant has no SAP credentials', async () => {
    const strategy = {
      normalizeFields: jest.fn().mockReturnValue([{ propertyName: 'x' }]),
      normalizeExclusions: jest.fn().mockReturnValue([]),
      requiresRemoteFetch: jest.fn().mockReturnValue(true),
    };
    const resolverFactory = jest.fn();
    const configRepository = buildConfigRepository({ strategyName: 's4', rawFields: [{}], rawExclusions: [] });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository,
      resolverFactory,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels([]) });

    expect(resolverFactory).not.toHaveBeenCalled();
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({});
  });

  it('swallows an unknown-strategy error so the product sync is not aborted', async () => {
    const configRepository = buildConfigRepository({ strategyName: 'nope', rawFields: [], rawExclusions: [] });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn(() => { throw new Error('Warehouse stock strategy not supported: nope'); }) },
      configRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await expect(
      adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() })
    ).resolves.toBeUndefined();
    expect(silentLogger.error).toHaveBeenCalled();
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toBeUndefined();
  });

  it('swallows a resolver failure so the product sync is not aborted', async () => {
    const strategy = {
      normalizeFields: jest.fn().mockReturnValue([{ propertyName: 'x', plant: 'MQGT', storageLocation: null, stockTypes: ['01'] }]),
      normalizeExclusions: jest.fn().mockReturnValue([]),
      requiresRemoteFetch: jest.fn().mockReturnValue(true),
      buildQueryTargets: jest.fn().mockReturnValue([{ plant: 'MQGT', storageLocations: null }]),
    };
    const resolver = { fetchStockRows: jest.fn().mockRejectedValue(new Error('gateway down')) };
    const configRepository = buildConfigRepository({ strategyName: 's4', rawFields: [{}], rawExclusions: [] });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository,
      resolverFactory: () => resolver,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await expect(
      adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() })
    ).resolves.toBeUndefined();
    expect(silentLogger.error).toHaveBeenCalled();
  });
});
