import { jest } from '@jest/globals';
import { S4LineItemStockAdapter } from '../../../src/infrastructure/sap/products/S4LineItemStockAdapter.js';

const SAP_CONFIG = { serviceLayerBaseUrl: 'https://sap.example', tenantKey: 'tenant-a' };
const TENANT_MODELS = { Configuration: {} };

function build({ config, rows = [] } = {}) {
  const configRepository = {
    getWarehouseStockConfig: jest.fn(async () => ({
      strategyName: 's4_PlantStorageLocation',
      rawFields: [],
      rawExclusions: [],
      rawAvailableFormula: null,
      ...config,
    })),
  };
  const resolver = { fetchStockRows: jest.fn(async () => rows) };
  const resolverFactory = jest.fn(() => resolver);
  const adapter = new S4LineItemStockAdapter({
    configRepository,
    resolverFactory,
  });

  return { adapter, configRepository, resolver, resolverFactory };
}

const row = (material, plant, storageLocation, quantity, stockType = '01') => ({
  Material: material,
  Plant: plant,
  StorageLocation: storageLocation,
  InventoryStockType: stockType,
  InventorySpecialStockType: '',
  MatlWrhsStkQtyInMatlBaseUnit: quantity,
});

describe('S4LineItemStockAdapter', () => {
  it('defaults to the real warehouse stock config repository', () => {
    const adapter = new S4LineItemStockAdapter();

    expect(typeof adapter.configRepository.getWarehouseStockConfig).toBe('function');
    expect(typeof adapter.resolverFactory).toBe('function');
  });

  it('returns an empty Map and makes no S/4 call when nothing is configured', async () => {
    const { adapter, resolverFactory, resolver } = build({ config: { rawFields: null } });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001'],
    });

    expect(result).toEqual(new Map());
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(resolver.fetchStockRows).not.toHaveBeenCalled();
  });

  it('returns an empty Map and makes no S/4 call for another strategy', async () => {
    const { adapter, resolver } = build({
      config: {
        strategyName: 'b1_ItemWarehouse',
        rawFields: [{ value: 'stock_a', valueSAP: 'MQGT/0008' }],
      },
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001'],
    });

    expect(result.size).toBe(0);
    expect(resolver.fetchStockRows).not.toHaveBeenCalled();
  });

  it('returns an empty Map when there are no item codes', async () => {
    const { adapter, resolver } = build({
      config: { rawFields: [{ value: 'stock_a', valueSAP: 'MQGT/0008' }] },
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: [],
    });

    expect(result.size).toBe(0);
    expect(resolver.fetchStockRows).not.toHaveBeenCalled();
  });

  it('builds the resolver with the tenant sapConfig and queries by material', async () => {
    const { adapter, resolver, resolverFactory } = build({
      config: { rawFields: [{ value: 'stock_a', valueSAP: 'MQGT/0008' }] },
      rows: [row('1001', 'MQGT', '0008', 5)],
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001', '1002', '1001'],
    });

    expect(resolverFactory).toHaveBeenCalledWith(SAP_CONFIG);
    expect(resolver.fetchStockRows).toHaveBeenCalledWith([
      { plant: 'MQGT', storageLocations: ['0008'], materials: ['1001', '1002'] },
    ]);
    expect(result.get('1001')).toEqual({ stock_a: 5 });
    // No stock row: every configured field is still emitted, as zero.
    expect(result.get('1002')).toEqual({ stock_a: 0 });
  });

  it('handles a wildcard plant (whole plant, all its storage locations)', async () => {
    const { adapter, resolver } = build({
      config: { rawFields: [{ value: 'stock_tm', valueSAP: 'TMDO/*' }] },
      rows: [row('1001', 'TMDO', '0001', 2), row('1001', 'TMDO', '0002', 3)],
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001'],
    });

    expect(resolver.fetchStockRows).toHaveBeenCalledWith([
      { plant: 'TMDO', storageLocations: null, materials: ['1001'] },
    ]);
    expect(result.get('1001')).toEqual({ stock_tm: 5 });
  });

  it('separates single storage locations of the same plant into their own properties', async () => {
    const { adapter } = build({
      config: {
        rawFields: [
          { value: 'stock_a', valueSAP: 'MQGT/0008' },
          { value: 'stock_b', valueSAP: 'MQGT/0500' },
        ],
      },
      rows: [row('1001', 'MQGT', '0008', 4), row('1001', 'MQGT', '0500', 7)],
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001'],
    });

    expect(result.get('1001')).toEqual({ stock_a: 4, stock_b: 7 });
  });

  it('counts only the configured stock types (default 01, explicit list otherwise)', async () => {
    const { adapter } = build({
      config: {
        rawFields: [
          { value: 'stock_free', valueSAP: 'MQGT/0008' },
          { value: 'stock_all', valueSAP: 'MQGT/0008', stockType: ['01', '02'] },
        ],
      },
      rows: [row('1001', 'MQGT', '0008', 4, '01'), row('1001', 'MQGT', '0008', 6, '02')],
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001'],
    });

    expect(result.get('1001')).toEqual({ stock_free: 4, stock_all: 10 });
  });

  it('applies the excluded warehouses', async () => {
    const { adapter } = build({
      config: {
        rawFields: [{ value: 'stock_tm', valueSAP: 'TMDO/*' }],
        rawExclusions: ['TMDO/0002'],
      },
      rows: [row('1001', 'TMDO', '0001', 2), row('1001', 'TMDO', '0002', 3)],
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001'],
    });

    expect(result.get('1001')).toEqual({ stock_tm: 2 });
  });

  it('does not change the configured property names', async () => {
    const { adapter } = build({
      config: { rawFields: [{ value: 'Stock Con Espacios', valueSAP: 'MQGT/0008' }] },
      rows: [row('1001', 'MQGT', '0008', 1)],
    });

    const result = await adapter.resolveStockProperties({
      sapConfig: SAP_CONFIG, tenantModels: TENANT_MODELS, itemCodes: ['1001'],
    });

    expect(Object.keys(result.get('1001'))).toEqual(['Stock Con Espacios']);
  });
});
