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

describe('WarehouseStockEnrichmentAdapter — formula de disponible', () => {
  beforeEach(() => jest.clearAllMocks());

  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };
  const config = (rawAvailableFormula) => buildConfigRepository({
    strategyName: 'b1_ItemWarehouse', rawFields: [{}], rawExclusions: [], rawAvailableFormula,
  });

  it('pasa la formula cruda a la strategy y la normalizada a buildProperties', async () => {
    const strategy = buildB1Strategy({ formula: NOELITO });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({ add: ['instock'], subtract: ['committed'] }),
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() });

    expect(strategy.normalizeAvailableFormula).toHaveBeenCalledWith(
      { add: ['instock'], subtract: ['committed'] },
      expect.objectContaining({ onInvalid: expect.any(Function) })
    );
    expect(strategy.buildProperties).toHaveBeenCalledWith(expect.objectContaining({ availableFormula: NOELITO }));
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });

  it('con formula invalida registra UN SyncWarning por corrida y pasa null a buildProperties', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({ invalidFormula: { raw: { add: ['InStok'] }, reason: 'unknown_field:InStok' } });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({ add: ['InStok'] }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({
      mappedRecords: buildRecords(3),
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(1);
    expect(syncWarningRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
      objectType: 'product',
      sapId: null,
      code: 'warehouse_available_formula_invalid',
      message: 'Warehouse available formula invalid: unknown_field:InStok',
      details: {
        raw: { add: ['InStok'] },
        reason: 'unknown_field:InStok',
        validFields: ['InStock', 'Committed', 'Ordered'],
      },
    }));
    expect(strategy.buildProperties).toHaveBeenCalledTimes(3);
    expect(strategy.buildProperties).toHaveBeenCalledWith(expect.objectContaining({ availableFormula: null }));
  });

  it('registra el warning aunque no haya ninguna bodega configurada', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({ fields: [], invalidFormula: { raw: {}, reason: 'empty_formula' } });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({}),
      syncWarningRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(1);
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({});
  });

  it('formula invalida y metric invalida a la vez dan dos warnings con codigos distintos', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({
      invalidEntries: [{ propertyName: 'a01_instock', warehouseCode: 'A01', metric: 'inStok' }],
      invalidFormula: { raw: 'x', reason: 'not_an_object' },
    });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config('x'),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({ mappedRecords: buildRecords(1), objectType: 'product', tenantModels: buildTenantModels() });

    const codes = syncWarningRepository.record.mock.calls.map(([call]) => call.code).sort();
    expect(codes).toEqual(['warehouse_available_formula_invalid', 'warehouse_metric_invalid']);
  });

  it('con la formula valida no registra nada', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy()) },
      configRepository: config(null),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({ mappedRecords: buildRecords(1), objectType: 'product', tenantModels: buildTenantModels() });

    expect(syncWarningRepository.record).not.toHaveBeenCalled();
  });

  it('sin syncWarningRepository no tira, y si record rechaza las propiedades se escriben igual', async () => {
    const strategy = buildB1Strategy({ invalidFormula: { raw: {}, reason: 'empty_formula' } });
    const sinRepo = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({}),
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await expect(sinRepo.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() }))
      .resolves.toBeUndefined();
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });

    const conRepoRoto = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: config({}),
      syncWarningRepository: { record: jest.fn().mockRejectedValue(new Error('mongo down')) },
      logger: silentLogger,
    });
    const records2 = buildRecords(1);

    await conRepoRoto.enrich({ mappedRecords: records2, objectType: 'product', tenantModels: buildTenantModels() });

    expect(records2[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });

  it('una strategy que devuelve undefined (S/4) con un documento basura no registra nada', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const s4 = {
      normalizeFields: jest.fn().mockReturnValue([]),
      normalizeExclusions: jest.fn().mockReturnValue([]),
      normalizeAvailableFormula: jest.fn().mockReturnValue(undefined),
      requiresRemoteFetch: jest.fn().mockReturnValue(true),
    };
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(s4) },
      configRepository: buildConfigRepository({
        strategyName: 's4_PlantStorageLocation', rawFields: null, rawExclusions: null, rawAvailableFormula: 'basura',
      }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({ mappedRecords: buildRecords(1), objectType: 'product', tenantModels: buildTenantModels() });

    expect(syncWarningRepository.record).not.toHaveBeenCalled();
  });
});

function buildB1Strategy({
  invalidEntries = [],
  fields = [{ warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'available' }],
  formula = { add: ['InStock', 'Ordered'], subtract: ['Committed'] },
  invalidFormula = null,
} = {}) {
  return {
    normalizeFields: jest.fn((rawValue, { onInvalidMetric } = {}) => {
      invalidEntries.forEach((entry) => onInvalidMetric?.(entry));
      return fields;
    }),
    normalizeExclusions: jest.fn().mockReturnValue([]),
    normalizeAvailableFormula: jest.fn((rawValue, { onInvalid } = {}) => {
      if (invalidFormula) {
        onInvalid?.(invalidFormula);
        return null;
      }
      return formula;
    }),
    requiresRemoteFetch: jest.fn().mockReturnValue(false),
    buildProperties: jest.fn().mockReturnValue({ a01_stock: 5 }),
  };
}

function buildSyncWarningRepository() {
  return { record: jest.fn().mockResolvedValue({ _id: 'warn-1' }) };
}

describe('WarehouseStockEnrichmentAdapter — avisos de metric invalida', () => {
  beforeEach(() => jest.clearAllMocks());

  const invalid = [
    { propertyName: 'a01_instock', warehouseCode: 'A01', metric: 'inStok' },
    { propertyName: 'a02_instock', warehouseCode: 'A02', metric: 'total' },
  ];

  it('records one SyncWarning per misconfigured entry', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const strategy = buildB1Strategy({ invalidEntries: invalid });
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(strategy) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({
      mappedRecords: buildRecords(1),
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(2);
    expect(syncWarningRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
      objectType: 'product',
      code: 'warehouse_metric_invalid',
      message: 'Warehouse stock metric not supported: "inStok"',
      details: {
        propertyName: 'a01_instock',
        warehouseCode: 'A01',
        metric: 'inStok',
        validMetrics: ['available', 'inStock', 'committed', 'ordered'],
      },
    }));
  });

  it('records once per entry, not once per product', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: [invalid[0]] })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({
      mappedRecords: buildRecords(3),
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(1);
  });

  it('records the warning even when every entry is invalid and no field survives', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: invalid, fields: [] })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({
      mappedRecords: records,
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledTimes(2);
    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({});
  });

  it('does not record anything when the config is fully valid', async () => {
    const syncWarningRepository = buildSyncWarningRepository();
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy()) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });

    await adapter.enrich({
      mappedRecords: buildRecords(1),
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(syncWarningRepository.record).not.toHaveBeenCalled();
  });

  it('enriches normally when no syncWarningRepository is injected', async () => {
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: invalid })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({
      mappedRecords: records,
      objectType: 'product',
      tenantModels: buildTenantModels(),
    });

    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });

  it('still writes the valid properties when recording a warning fails', async () => {
    const syncWarningRepository = { record: jest.fn().mockRejectedValue(new Error('mongo down')) };
    const adapter = new WarehouseStockEnrichmentAdapter({
      strategyFactory: { getStrategy: jest.fn().mockReturnValue(buildB1Strategy({ invalidEntries: [invalid[0]] })) },
      configRepository: buildConfigRepository({ strategyName: 'b1_ItemWarehouse', rawFields: [], rawExclusions: [] }),
      syncWarningRepository,
      logger: silentLogger,
    });
    const records = buildRecords(1);

    await adapter.enrich({
      mappedRecords: records,
      objectType: 'product',
      tenantModels: buildTenantModels(),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
    });

    expect(records[0].rawSapData[WAREHOUSE_STOCK_KEY]).toEqual({ a01_stock: 5 });
  });
});
