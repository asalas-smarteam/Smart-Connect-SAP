import {
  B1ItemWarehouseStrategy,
  buildB1WarehouseStockProperties,
  getAvailableStockForB1Warehouse,
  getWarehouseAvailableStock,
  getWarehouseMetricValue,
  normalizeB1ExcludedWarehouses,
  normalizeB1StockMetric,
  normalizeB1WarehouseFields,
} from '../../../src/domain/warehouses/strategies/b1-item-warehouse.strategy.js';

describe('getWarehouseAvailableStock', () => {
  it('computes InStock - Committed + Ordered', () => {
    expect(getWarehouseAvailableStock({ InStock: 7, Committed: 1, Ordered: 2 })).toBe(8);
  });

  it('treats a missing warehouse as all zeros', () => {
    expect(getWarehouseAvailableStock(undefined)).toBe(0);
  });
});

describe('normalizeB1WarehouseFields', () => {
  it('uses valueSAP as the warehouse code when present', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'DISTELSA', value: 'distelsa_stock', valueSAP: '01' },
    ])).toEqual([{ warehouseCode: '01', propertyName: 'distelsa_stock' }]);
  });

  it('falls back to deriving the code from a *_stock property name', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'Entrepiso-T1', value: 'A01_stock' },
    ])).toEqual([{ warehouseCode: 'A01', propertyName: 'A01_stock' }]);
  });

  it('drops a padded property name (the *_stock fallback regex is anchored) and an empty one', () => {
    // Same fixture as tests/unit/warehouseStock.test.js -- the padded " B10_stock "
    // never matches /^([A-Za-z0-9]+)_stock$/, so only the clean 'B10_stock' survives.
    expect(normalizeB1WarehouseFields([
      { label: 'PVC', value: ' B10_stock ' },
      { label: 'Duplicado', value: 'B10_stock' },
      { label: 'Inválido', value: '' },
    ])).toEqual([{ warehouseCode: 'B10', propertyName: 'B10_stock' }]);
  });

  it('dedupes two entries resolving to the same warehouseCode + propertyName, keeping the first', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'A', value: 'b10_stock', valueSAP: 'B10' },
      { label: 'B (duplicate, different case)', value: 'B10_stock', valueSAP: 'B10' },
    ])).toEqual([{ warehouseCode: 'B10', propertyName: 'b10_stock' }]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeB1WarehouseFields('B10_stock')).toEqual([]);
  });
});

describe('normalizeB1ExcludedWarehouses', () => {
  it('uppercases and dedupes', () => {
    expect(normalizeB1ExcludedWarehouses(['b11', 'B12', 'B11', ''])).toEqual(['B11', 'B12']);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeB1ExcludedWarehouses(null)).toEqual([]);
  });
});

describe('buildB1WarehouseStockProperties', () => {
  it('builds a property per configured warehouse, matching case-insensitively', () => {
    const properties = buildB1WarehouseStockProperties(
      [{ WarehouseCode: 'a01', Ordered: 2, Committed: 1, InStock: 7 }],
      [{ warehouseCode: 'A01', propertyName: 'A01_stock' }]
    );

    expect(properties).toEqual({ A01_stock: 8 });
  });

  it('resolves an unconfigured or missing warehouse to 0', () => {
    const properties = buildB1WarehouseStockProperties(
      [],
      [{ warehouseCode: 'C99', propertyName: 'C99_stock' }]
    );

    expect(properties).toEqual({ C99_stock: 0 });
  });

  it('forces an excluded warehouse to 0 even when SAP reports stock for it', () => {
    const properties = buildB1WarehouseStockProperties(
      [{ WarehouseCode: 'B11', InStock: 50 }],
      [{ warehouseCode: 'B11', propertyName: 'b11_stock' }],
      ['B11']
    );

    expect(properties).toEqual({ b11_stock: 0 });
  });

  it('does not throw on a field with no warehouseCode', () => {
    expect(() => buildB1WarehouseStockProperties([], [{ propertyName: 'x_stock' }])).not.toThrow();
    expect(buildB1WarehouseStockProperties([], [{ propertyName: 'x_stock' }])).toEqual({});
  });

  it('returns {} for null inputs', () => {
    expect(buildB1WarehouseStockProperties([], null)).toEqual({});
  });
});

describe('getAvailableStockForB1Warehouse', () => {
  it('returns stock for one warehouse without summing the others', () => {
    const available = getAvailableStockForB1Warehouse(
      [
        { WarehouseCode: 'B04', Ordered: 1, Committed: 2, InStock: 8 },
        { WarehouseCode: 'B10', Ordered: 9, Committed: 0, InStock: 9 },
      ],
      'B04'
    );

    expect(available).toBe(7);
  });

  it('returns 0 for a falsy warehouse code', () => {
    expect(getAvailableStockForB1Warehouse([], '')).toBe(0);
  });
});

describe('B1ItemWarehouseStrategy', () => {
  it('never requires a remote fetch', () => {
    expect(new B1ItemWarehouseStrategy().requiresRemoteFetch()).toBe(false);
  });

  it('reads stock straight off rawSapData.ItemWarehouseInfoCollection', () => {
    const strategy = new B1ItemWarehouseStrategy();
    const fields = strategy.normalizeFields([{ value: 'a01_stock', valueSAP: 'A01' }]);
    const record = { rawSapData: { ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', InStock: 5 }] } };

    expect(strategy.buildProperties({ record, fields, index: new Map() })).toEqual({ a01_stock: 5 });
  });

  it('implements the WarehouseStockStrategyPort contract', () => {
    const strategy = new B1ItemWarehouseStrategy();

    ['normalizeFields', 'normalizeExclusions', 'requiresRemoteFetch', 'buildQueryTargets', 'buildIndex', 'buildProperties']
      .forEach((method) => expect(typeof strategy[method]).toBe('function'));
  });
});

describe('normalizeB1StockMetric', () => {
  it('defaults to available when the metric is absent or blank', () => {
    expect(normalizeB1StockMetric(undefined)).toBe('available');
    expect(normalizeB1StockMetric(null)).toBe('available');
    expect(normalizeB1StockMetric('')).toBe('available');
    expect(normalizeB1StockMetric('   ')).toBe('available');
  });

  it('matches case-insensitively and trims, returning the canonical name', () => {
    expect(normalizeB1StockMetric('InStock')).toBe('inStock');
    expect(normalizeB1StockMetric('instock')).toBe('inStock');
    expect(normalizeB1StockMetric(' inStock ')).toBe('inStock');
    expect(normalizeB1StockMetric('COMMITTED')).toBe('committed');
    expect(normalizeB1StockMetric('Ordered')).toBe('ordered');
    expect(normalizeB1StockMetric('available')).toBe('available');
  });

  it('returns null for a metric that does not exist', () => {
    expect(normalizeB1StockMetric('inStok')).toBeNull();
    expect(normalizeB1StockMetric('total')).toBeNull();
    expect(normalizeB1StockMetric('in stock')).toBeNull();
  });
});

describe('getWarehouseMetricValue', () => {
  const warehouse = { InStock: 7, Committed: 1, Ordered: 2 };

  it('returns the raw SAP field for each separate metric', () => {
    expect(getWarehouseMetricValue(warehouse, 'inStock')).toBe(7);
    expect(getWarehouseMetricValue(warehouse, 'committed')).toBe(1);
    expect(getWarehouseMetricValue(warehouse, 'ordered')).toBe(2);
  });

  it('returns InStock - Committed + Ordered for available', () => {
    expect(getWarehouseMetricValue(warehouse, 'available')).toBe(8);
  });

  it('treats a legacy field with no metric as available', () => {
    expect(getWarehouseMetricValue(warehouse, undefined)).toBe(8);
  });

  it('treats a missing warehouse as zero for every metric', () => {
    ['available', 'inStock', 'committed', 'ordered'].forEach((metric) => {
      expect(getWarehouseMetricValue(undefined, metric)).toBe(0);
    });
  });

  it('treats a missing SAP field as zero', () => {
    expect(getWarehouseMetricValue({ InStock: 5 }, 'committed')).toBe(0);
    expect(getWarehouseMetricValue({ InStock: 5 }, 'ordered')).toBe(0);
    expect(getWarehouseMetricValue({ InStock: 5 }, 'available')).toBe(5);
  });
});
