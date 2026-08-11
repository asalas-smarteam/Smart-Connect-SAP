import {
  S4PlantStorageLocationStrategy,
  buildS4StockIndex,
  buildS4StockProperties,
  buildS4StockQueryTargets,
  normalizeS4ExcludedWarehouses,
  normalizeS4StockTypes,
  normalizeS4WarehouseFields,
  parseS4WarehouseCode,
} from '../../../src/domain/warehouses/strategies/s4-plant-storage-location.strategy.js';

describe('parseS4WarehouseCode', () => {
  it('parses Plant/StorageLocation', () => {
    expect(parseS4WarehouseCode('MQGT/0008')).toEqual({ plant: 'MQGT', storageLocation: '0008' });
  });

  it('treats a wildcard or bare plant as the whole plant', () => {
    expect(parseS4WarehouseCode('DPDO/*')).toEqual({ plant: 'DPDO', storageLocation: null });
    expect(parseS4WarehouseCode('DPDO')).toEqual({ plant: 'DPDO', storageLocation: null });
    expect(parseS4WarehouseCode('dpdo')).toEqual({ plant: 'DPDO', storageLocation: null });
  });

  it('rejects invalid input', () => {
    expect(parseS4WarehouseCode('')).toBeNull();
    expect(parseS4WarehouseCode(null)).toBeNull();
    expect(parseS4WarehouseCode('A/B/C')).toBeNull();
    expect(parseS4WarehouseCode('/0008')).toBeNull();
  });
});

describe('normalizeS4StockTypes', () => {
  it('defaults to unrestricted-use stock (01) when absent', () => {
    expect(normalizeS4StockTypes(undefined)).toEqual(['01']);
    expect(normalizeS4StockTypes('')).toEqual(['01']);
  });

  it('accepts a single code', () => {
    expect(normalizeS4StockTypes('02')).toEqual(['02']);
  });

  it('accepts an array and dedupes it', () => {
    expect(normalizeS4StockTypes(['01', '02', '04', '07', '01'])).toEqual(['01', '02', '04', '07']);
  });

  it('accepts the wildcard', () => {
    expect(normalizeS4StockTypes('*')).toBe('*');
    expect(normalizeS4StockTypes(['*'])).toEqual(['*']);
  });
});

describe('normalizeS4WarehouseFields', () => {
  it('parses each field and keeps propertyName/plant/storageLocation/stockTypes', () => {
    const fields = normalizeS4WarehouseFields([
      { label: 'MQGT 0008', value: 'mqgt_0008_stock', valueSAP: 'MQGT/0008' },
      { label: 'MQGT 0008 - Calidad', value: 'mqgt_0008_calidad', valueSAP: 'MQGT/0008', stockType: '02' },
      { label: 'DPDO completo', value: 'dpdo_stock', valueSAP: 'DPDO/*' },
    ]);

    expect(fields).toEqual([
      { propertyName: 'mqgt_0008_stock', plant: 'MQGT', storageLocation: '0008', stockTypes: ['01'] },
      { propertyName: 'mqgt_0008_calidad', plant: 'MQGT', storageLocation: '0008', stockTypes: ['02'] },
      { propertyName: 'dpdo_stock', plant: 'DPDO', storageLocation: null, stockTypes: ['01'] },
    ]);
  });

  it('discards entries with no value or an invalid valueSAP', () => {
    expect(normalizeS4WarehouseFields([
      { value: '', valueSAP: 'MQGT/0008' },
      { value: 'x_stock', valueSAP: '' },
      { value: 'y_stock', valueSAP: 'A/B/C' },
    ])).toEqual([]);
  });

  it('dedupes by propertyName, keeping the first entry (two entries per field is a config mistake, not a sum)', () => {
    const fields = normalizeS4WarehouseFields([
      { value: 'mqgt_0008_stock', valueSAP: 'MQGT/0008', stockType: '01' },
      { value: 'mqgt_0008_stock', valueSAP: 'MQGT/0500', stockType: '02' },
    ]);

    expect(fields).toEqual([
      { propertyName: 'mqgt_0008_stock', plant: 'MQGT', storageLocation: '0008', stockTypes: ['01'] },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeS4WarehouseFields(null)).toEqual([]);
    expect(normalizeS4WarehouseFields('mqgt_0008_stock')).toEqual([]);
  });
});

describe('normalizeS4ExcludedWarehouses', () => {
  it('parses each entry with the same grammar as valueSAP', () => {
    expect(normalizeS4ExcludedWarehouses(['MQGT/0006', 'DPDO/*', 'invalid/x/y'])).toEqual([
      { plant: 'MQGT', storageLocation: '0006' },
      { plant: 'DPDO', storageLocation: null },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeS4ExcludedWarehouses(null)).toEqual([]);
  });
});

describe('buildS4StockQueryTargets', () => {
  it('groups fields by plant, unioning explicit storage locations', () => {
    const fields = normalizeS4WarehouseFields([
      { value: 'a', valueSAP: 'MQGT/0008' },
      { value: 'b', valueSAP: 'MQGT/0500' },
      { value: 'c', valueSAP: 'DPDO/*' },
    ]);

    expect(buildS4StockQueryTargets(fields)).toEqual([
      { plant: 'MQGT', storageLocations: ['0008', '0500'] },
      { plant: 'DPDO', storageLocations: null },
    ]);
  });

  it('a wildcard field wins over an explicit one for the same plant', () => {
    const fields = normalizeS4WarehouseFields([
      { value: 'a', valueSAP: 'MQGT/0008' },
      { value: 'b', valueSAP: 'MQGT/*' },
    ]);

    expect(buildS4StockQueryTargets(fields)).toEqual([
      { plant: 'MQGT', storageLocations: null },
    ]);
  });
});

describe('buildS4StockIndex', () => {
  function row(overrides) {
    return {
      Material: '1002',
      Plant: 'MQGT',
      StorageLocation: '0008',
      InventorySpecialStockType: '',
      InventoryStockType: '01',
      MatlWrhsStkQtyInMatlBaseUnit: '10',
      ...overrides,
    };
  }

  it('sums duplicate rows differing only by batch/supplier/customer', () => {
    const index = buildS4StockIndex([row({}), row({ MatlWrhsStkQtyInMatlBaseUnit: '5' })]);

    expect(index.get('1002')).toEqual([
      { plant: 'MQGT', storageLocation: '0008', stockType: '01', quantity: 15 },
    ]);
  });

  it('does not mix the same StorageLocation code across different plants', () => {
    const index = buildS4StockIndex([
      row({ Material: '1002', Plant: 'MQGT', StorageLocation: '0008', MatlWrhsStkQtyInMatlBaseUnit: '10' }),
      row({ Material: '1002', Plant: 'MQDO', StorageLocation: '0008', MatlWrhsStkQtyInMatlBaseUnit: '99' }),
    ]);

    const entries = index.get('1002');
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.plant === 'MQGT').quantity).toBe(10);
    expect(entries.find((e) => e.plant === 'MQDO').quantity).toBe(99);
  });

  it('discards rows with a non-blank InventorySpecialStockType', () => {
    const index = buildS4StockIndex([row({ InventorySpecialStockType: 'K' })]);
    expect(index.has('1002')).toBe(false);
  });

  it('discards rows with no material', () => {
    const index = buildS4StockIndex([row({ Material: '' })]);
    expect(index.size).toBe(0);
  });

  it('discards rows under an excluded plant/storage location', () => {
    const exclusions = normalizeS4ExcludedWarehouses(['MQGT/0008']);
    const index = buildS4StockIndex(
      [row({}), row({ StorageLocation: '0500' })],
      { exclusions }
    );

    expect(index.get('1002')).toEqual([
      { plant: 'MQGT', storageLocation: '0500', stockType: '01', quantity: 10 },
    ]);
  });

  it('a whole-plant exclusion drops every storage location under it', () => {
    const exclusions = normalizeS4ExcludedWarehouses(['MQGT/*']);
    const index = buildS4StockIndex([row({}), row({ StorageLocation: '0500' })], { exclusions });

    expect(index.has('1002')).toBe(false);
  });
});

describe('buildS4StockProperties', () => {
  const fields = normalizeS4WarehouseFields([
    { value: 'mqgt_0008_stock', valueSAP: 'MQGT/0008' },
    { value: 'mqgt_0008_calidad', valueSAP: 'MQGT/0008', stockType: '02' },
    { value: 'mqgt_0008_total', valueSAP: 'MQGT/0008', stockType: ['01', '02', '04', '07'] },
    { value: 'dpdo_stock', valueSAP: 'DPDO/*' },
    { value: 'no_match_stock', valueSAP: 'GPDO/0001' },
  ]);

  it('sums matching rows per field and always emits every configured field', () => {
    const index = buildS4StockIndex([
      { Material: '1002', Plant: 'MQGT', StorageLocation: '0008', InventorySpecialStockType: '', InventoryStockType: '01', MatlWrhsStkQtyInMatlBaseUnit: '10' },
      { Material: '1002', Plant: 'MQGT', StorageLocation: '0008', InventorySpecialStockType: '', InventoryStockType: '02', MatlWrhsStkQtyInMatlBaseUnit: '3' },
      { Material: '1002', Plant: 'DPDO', StorageLocation: '0400', InventorySpecialStockType: '', InventoryStockType: '01', MatlWrhsStkQtyInMatlBaseUnit: '7' },
    ]);

    const properties = buildS4StockProperties({
      record: { rawSapData: { Product: '1002' } },
      index,
      fields,
    });

    expect(properties).toEqual({
      mqgt_0008_stock: 10,
      mqgt_0008_calidad: 3,
      mqgt_0008_total: 13,
      dpdo_stock: 7,
      no_match_stock: 0,
    });
  });

  it('resolves to all zeros for a material with no stock rows', () => {
    const properties = buildS4StockProperties({
      record: { rawSapData: { Product: '9999' } },
      index: new Map(),
      fields,
    });

    expect(properties).toEqual({
      mqgt_0008_stock: 0,
      mqgt_0008_calidad: 0,
      mqgt_0008_total: 0,
      dpdo_stock: 0,
      no_match_stock: 0,
    });
  });

  it('rounds away floating point noise', () => {
    const index = buildS4StockIndex([
      { Material: '1002', Plant: 'MQGT', StorageLocation: '0008', InventorySpecialStockType: '', InventoryStockType: '01', MatlWrhsStkQtyInMatlBaseUnit: '0.1' },
      { Material: '1002', Plant: 'MQGT', StorageLocation: '0008', InventorySpecialStockType: '', InventoryStockType: '01', MatlWrhsStkQtyInMatlBaseUnit: '0.2' },
    ]);

    const properties = buildS4StockProperties({
      record: { rawSapData: { Product: '1002' } },
      index,
      fields: normalizeS4WarehouseFields([{ value: 'mqgt_0008_stock', valueSAP: 'MQGT/0008' }]),
    });

    expect(properties.mqgt_0008_stock).toBe(0.3);
  });
});

describe('S4PlantStorageLocationStrategy', () => {
  it('requires a remote fetch', () => {
    expect(new S4PlantStorageLocationStrategy().requiresRemoteFetch()).toBe(true);
  });

  it('implements the WarehouseStockStrategyPort contract', () => {
    const strategy = new S4PlantStorageLocationStrategy();

    ['normalizeFields', 'normalizeExclusions', 'requiresRemoteFetch', 'buildQueryTargets', 'buildIndex', 'buildProperties']
      .forEach((method) => expect(typeof strategy[method]).toBe('function'));
  });
});
