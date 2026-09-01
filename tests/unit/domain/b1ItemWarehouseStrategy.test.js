import { jest } from '@jest/globals';
import {
  B1ItemWarehouseStrategy,
  buildB1WarehouseStockProperties,
  getAvailableStockForB1Warehouse,
  getWarehouseAvailableStock,
  getWarehouseMetricValue,
  normalizeB1AvailableFormula,
  normalizeB1ExcludedWarehouses,
  normalizeB1StockMetric,
  normalizeB1WarehouseFields,
} from '../../../src/domain/warehouses/strategies/b1-item-warehouse.strategy.js';
import {
  DEFAULT_B1_AVAILABLE_FORMULA,
  B1_STOCK_METRICS,
  B1_WAREHOUSE_STOCK_FIELDS,
  DEFAULT_B1_STOCK_METRIC,
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
  WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING,
} from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';

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
    ])).toEqual([{ warehouseCode: '01', propertyName: 'distelsa_stock', metric: 'available' }]);
  });

  it('falls back to deriving the code from a *_stock property name', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'Entrepiso-T1', value: 'A01_stock' },
    ])).toEqual([{ warehouseCode: 'A01', propertyName: 'A01_stock', metric: 'available' }]);
  });

  it('drops a padded property name (the *_stock fallback regex is anchored) and an empty one', () => {
    // Same fixture as tests/unit/warehouseStock.test.js -- the padded " B10_stock "
    // never matches /^([A-Za-z0-9]+)_stock$/, so only the clean 'B10_stock' survives.
    expect(normalizeB1WarehouseFields([
      { label: 'PVC', value: ' B10_stock ' },
      { label: 'Duplicado', value: 'B10_stock' },
      { label: 'Inválido', value: '' },
    ])).toEqual([{ warehouseCode: 'B10', propertyName: 'B10_stock', metric: 'available' }]);
  });

  it('dedupes two entries resolving to the same warehouseCode + propertyName, keeping the first', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'A', value: 'b10_stock', valueSAP: 'B10' },
      { label: 'B (duplicate, different case)', value: 'B10_stock', valueSAP: 'B10' },
    ])).toEqual([{ warehouseCode: 'B10', propertyName: 'b10_stock', metric: 'available' }]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeB1WarehouseFields('B10_stock')).toEqual([]);
  });

  it('defaults a field with no metric to available', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'A01', value: 'a01_stock', valueSAP: 'A01' },
    ])).toEqual([{ warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'available' }]);
  });

  it('resolves the metric to its canonical name', () => {
    expect(normalizeB1WarehouseFields([
      { label: 'A01 en stock', value: 'a01_instock', valueSAP: 'A01', metric: 'InStock' },
    ])).toEqual([{ warehouseCode: 'A01', propertyName: 'a01_instock', metric: 'inStock' }]);
  });

  it('keeps three entries for the same warehouse with different metrics', () => {
    expect(normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStock' },
      { value: 'a01_committed', valueSAP: 'A01', metric: 'committed' },
      { value: 'a01_ordered', valueSAP: 'A01', metric: 'ordered' },
    ])).toEqual([
      { warehouseCode: 'A01', propertyName: 'a01_instock', metric: 'inStock' },
      { warehouseCode: 'A01', propertyName: 'a01_committed', metric: 'committed' },
      { warehouseCode: 'A01', propertyName: 'a01_ordered', metric: 'ordered' },
    ]);
  });

  it('drops an entry with an unsupported metric and reports the raw value', () => {
    const onInvalidMetric = jest.fn();

    const fields = normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStok' },
      { value: 'a02_instock', valueSAP: 'A02', metric: 'inStock' },
    ], { onInvalidMetric });

    expect(fields).toEqual([
      { warehouseCode: 'A02', propertyName: 'a02_instock', metric: 'inStock' },
    ]);
    expect(onInvalidMetric).toHaveBeenCalledTimes(1);
    expect(onInvalidMetric).toHaveBeenCalledWith({
      propertyName: 'a01_instock',
      warehouseCode: 'A01',
      metric: 'inStok',
    });
  });

  it('drops an unsupported metric without throwing when no reporter is passed', () => {
    expect(() => normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStok' },
    ])).not.toThrow();
    expect(normalizeB1WarehouseFields([
      { value: 'a01_instock', valueSAP: 'A01', metric: 'inStok' },
    ])).toEqual([]);
  });

  it('does not dedupe two entries that differ only by metric', () => {
    // Config erronea del cliente (dos metricas a la MISMA propiedad). Sobreviven
    // las dos a la normalizacion y el reduce de buildB1WarehouseStockProperties
    // deja ganar a la ultima, igual que hoy con dos bodegas apuntando a una
    // sola propiedad.
    expect(normalizeB1WarehouseFields([
      { value: 'a01_x', valueSAP: 'A01', metric: 'inStock' },
      { value: 'a01_x', valueSAP: 'A01', metric: 'ordered' },
    ])).toHaveLength(2);
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

// ItemWarehouseInfoCollection real del producto P27020056 (18 bodegas),
// reducido a los cuatro campos que la strategy lee. Los unicos valores no
// nulos del payload real son A02.InStock=1, B09.InStock=66 y B12.Ordered=1400.
const P27020056_STOCK = {
  A02: { InStock: 1 },
  B09: { InStock: 66 },
  B12: { Ordered: 1400 },
};

const P27020056_WAREHOUSES = [
  'A01', 'A02', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08',
  'B09', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'PA',
].map((WarehouseCode) => ({
  WarehouseCode,
  ItemCode: 'P27020056',
  InStock: 0,
  Committed: 0,
  Ordered: 0,
  ...P27020056_STOCK[WarehouseCode],
}));

describe('buildB1WarehouseStockProperties', () => {
  it('emits the three separate metrics for one warehouse (AMC profile)', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'B09', propertyName: 'b09_instock', metric: 'inStock' },
      { warehouseCode: 'B09', propertyName: 'b09_committed', metric: 'committed' },
      { warehouseCode: 'B09', propertyName: 'b09_ordered', metric: 'ordered' },
      { warehouseCode: 'B12', propertyName: 'b12_instock', metric: 'inStock' },
      { warehouseCode: 'B12', propertyName: 'b12_ordered', metric: 'ordered' },
      { warehouseCode: 'A02', propertyName: 'a02_instock', metric: 'inStock' },
    ]);

    expect(properties).toEqual({
      b09_instock: 66,
      b09_committed: 0,
      b09_ordered: 0,
      b12_instock: 0,
      b12_ordered: 1400,
      a02_instock: 1,
    });
  });

  it('emits only InStock, leaving Ordered out (Printer profile)', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'inStock' },
      { warehouseCode: 'B09', propertyName: 'b09_stock', metric: 'inStock' },
      { warehouseCode: 'B12', propertyName: 'b12_stock', metric: 'inStock' },
    ]);

    // B12 tiene Ordered 1400 y NO entra: con metric inStock la propiedad es 0.
    expect(properties).toEqual({ a01_stock: 0, b09_stock: 66, b12_stock: 0 });
  });

  it('keeps the historical formula for fields with no metric (Distelsa/Noelito profile)', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'A02', propertyName: 'a02_stock' },
      { warehouseCode: 'B09', propertyName: 'b09_stock' },
      { warehouseCode: 'B12', propertyName: 'b12_stock' },
    ]);

    // b12 = 0 - 0 + 1400: la formula historica cuenta lo pedido como disponible.
    expect(properties).toEqual({ a02_stock: 1, b09_stock: 66, b12_stock: 1400 });
  });

  it('resolves a configured warehouse missing from the payload to 0 for any metric', () => {
    const properties = buildB1WarehouseStockProperties(P27020056_WAREHOUSES, [
      { warehouseCode: 'C99', propertyName: 'c99_instock', metric: 'inStock' },
      { warehouseCode: 'C99', propertyName: 'c99_committed', metric: 'committed' },
    ]);

    expect(properties).toEqual({ c99_instock: 0, c99_committed: 0 });
  });

  it('forces an excluded warehouse to 0 in all three metrics', () => {
    const properties = buildB1WarehouseStockProperties(
      P27020056_WAREHOUSES,
      [
        { warehouseCode: 'B09', propertyName: 'b09_instock', metric: 'inStock' },
        { warehouseCode: 'B09', propertyName: 'b09_committed', metric: 'committed' },
        { warehouseCode: 'B09', propertyName: 'b09_ordered', metric: 'ordered' },
      ],
      ['B09']
    );

    expect(properties).toEqual({ b09_instock: 0, b09_committed: 0, b09_ordered: 0 });
  });

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

    ['normalizeFields', 'normalizeExclusions', 'normalizeAvailableFormula', 'requiresRemoteFetch', 'buildQueryTargets', 'buildIndex', 'buildProperties']
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

describe('constantes de la formula de disponible', () => {
  it('expone la clave, los campos validos, el default y el codigo del warning', () => {
    expect(WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY).toBe('warehouseAvailableFormula');
    expect(B1_WAREHOUSE_STOCK_FIELDS).toEqual(['InStock', 'Committed', 'Ordered']);
    expect(DEFAULT_B1_AVAILABLE_FORMULA).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
    expect(Object.isFrozen(DEFAULT_B1_AVAILABLE_FORMULA)).toBe(true);
    expect(WAREHOUSE_AVAILABLE_FORMULA_INVALID_WARNING).toBe('warehouse_available_formula_invalid');
  });
});

describe('normalizeB1AvailableFormula', () => {
  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };

  it('documento ausente o null = default historico', () => {
    expect(normalizeB1AvailableFormula(undefined)).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
    expect(normalizeB1AvailableFormula(null)).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
  });

  it('canonicaliza nombres sin distinguir mayusculas ni espacios', () => {
    expect(normalizeB1AvailableFormula({ add: [' instock '], subtract: ['COMMITTED'] })).toEqual(NOELITO);
  });

  it('lista ausente = vacia, y los duplicados dentro de una lista se colapsan', () => {
    expect(normalizeB1AvailableFormula({ add: ['InStock', 'InStock'] })).toEqual({ add: ['InStock'], subtract: [] });
  });

  it.each([
    ['InStock - Committed', 'not_an_object'],
    [['InStock'], 'not_an_object'],
    [42, 'not_an_object'],
    [{ add: 'InStock' }, 'add_not_an_array'],
    [{ add: ['InStock'], subtract: 'Committed' }, 'subtract_not_an_array'],
    [{ add: ['InStok'] }, 'unknown_field:InStok'],
    [{ add: ['InStock'], subtract: ['MinimalStock'] }, 'unknown_field:MinimalStock'],
    [{ add: ['InStock'], subtract: ['instock'] }, 'field_in_both_lists:InStock'],
    [{ add: [], subtract: [] }, 'empty_formula'],
    [{}, 'empty_formula'],
  ])('devuelve null y reporta %j como %s', (raw, reason) => {
    const onInvalid = jest.fn();

    expect(normalizeB1AvailableFormula(raw, { onInvalid })).toBeNull();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid).toHaveBeenCalledWith({ raw, reason });
  });

  it('sin onInvalid una formula invalida devuelve null y no tira', () => {
    expect(() => normalizeB1AvailableFormula({ add: ['InStok'] })).not.toThrow();
    expect(normalizeB1AvailableFormula({ add: ['InStok'] })).toBeNull();
  });
});

describe('getWarehouseAvailableStock con formula', () => {
  const warehouse = { InStock: 7, Committed: 1, Ordered: 2 };

  it('aplica la formula de Noelito', () => {
    expect(getWarehouseAvailableStock(warehouse, { add: ['InStock'], subtract: ['Committed'] })).toBe(6);
  });

  it('acepta una lista vacia', () => {
    expect(getWarehouseAvailableStock(warehouse, { add: ['InStock'], subtract: [] })).toBe(7);
  });

  it('puede dar negativo', () => {
    expect(getWarehouseAvailableStock(warehouse, { add: ['Ordered'], subtract: ['InStock', 'Committed'] })).toBe(-6);
  });

  it('bodega ausente da 0 con cualquier formula', () => {
    expect(getWarehouseAvailableStock(undefined, { add: ['InStock'], subtract: ['Committed'] })).toBe(0);
  });

  it('campo ausente en la bodega cuenta como 0', () => {
    expect(getWarehouseAvailableStock({ InStock: 5 }, { add: ['InStock', 'Ordered'], subtract: ['Committed'] })).toBe(5);
  });

  it('con el default reproduce bit por bit (InStock - Committed) + Ordered, tambien con flotantes', () => {
    const warehouse = { InStock: 0.1, Committed: 0.2, Ordered: 0.3 };
    expect(getWarehouseAvailableStock(warehouse)).toBe((0.1 - 0.2) + 0.3);
    expect(getWarehouseAvailableStock(warehouse, { add: ['Ordered', 'InStock'], subtract: ['Committed'] })).toBe((0.1 - 0.2) + 0.3);
  });
});

describe('getWarehouseMetricValue con formula', () => {
  const warehouse = { InStock: 7, Committed: 1, Ordered: 2 };
  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };

  it('available usa la formula recibida', () => {
    expect(getWarehouseMetricValue(warehouse, 'available', NOELITO)).toBe(6);
    expect(getWarehouseMetricValue(warehouse, undefined, NOELITO)).toBe(6);
  });

  it('las metricas crudas ignoran la formula', () => {
    expect(getWarehouseMetricValue(warehouse, 'inStock', NOELITO)).toBe(7);
    expect(getWarehouseMetricValue(warehouse, 'committed', NOELITO)).toBe(1);
    expect(getWarehouseMetricValue(warehouse, 'ordered', NOELITO)).toBe(2);
  });
});

describe('buildB1WarehouseStockProperties con formula', () => {
  const NOELITO = { add: ['InStock'], subtract: ['Committed'] };
  const items = [
    { WarehouseCode: 'A01', InStock: 10, Committed: 4, Ordered: 100 },
    { WarehouseCode: 'B09', InStock: 66, Committed: 0, Ordered: 0 },
  ];
  const fields = [
    { warehouseCode: 'A01', propertyName: 'a01_stock', metric: 'available' },
    { warehouseCode: 'A01', propertyName: 'a01_instock', metric: 'inStock' },
    { warehouseCode: 'B09', propertyName: 'b09_stock', metric: 'available' },
  ];

  it('aplica la formula a las entradas available y deja las crudas como estan', () => {
    expect(buildB1WarehouseStockProperties(items, fields, [], { availableFormula: NOELITO })).toEqual({
      a01_stock: 6,
      a01_instock: 10,
      b09_stock: 66,
    });
  });

  it('sin cuarto argumento da los numeros historicos', () => {
    expect(buildB1WarehouseStockProperties(items, fields)).toEqual({
      a01_stock: 106,
      a01_instock: 10,
      b09_stock: 66,
    });
  });

  it('con formula invalida (null) omite las available y conserva las crudas', () => {
    const properties = buildB1WarehouseStockProperties(items, fields, [], { availableFormula: null });

    expect(properties).toEqual({ a01_instock: 10 });
    expect(Object.prototype.hasOwnProperty.call(properties, 'a01_stock')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(properties, 'b09_stock')).toBe(false);
  });

  it('con formula invalida, una bodega excluida sigue saliendo en 0', () => {
    expect(buildB1WarehouseStockProperties(items, fields, ['B09'], { availableFormula: null })).toEqual({
      a01_instock: 10,
      b09_stock: 0,
    });
  });

  it('con formula invalida, un field a mano sin metric tambien es available y se omite', () => {
    const legacyFields = [{ warehouseCode: 'A01', propertyName: 'a01_stock' }];

    expect(buildB1WarehouseStockProperties(items, legacyFields, [], { availableFormula: null })).toEqual({});
  });
});

describe('B1ItemWarehouseStrategy — formula de disponible', () => {
  it('normalizeAvailableFormula delega y pasa options', () => {
    const strategy = new B1ItemWarehouseStrategy();
    const onInvalid = jest.fn();

    expect(strategy.normalizeAvailableFormula({ add: ['instock'], subtract: ['committed'] }))
      .toEqual({ add: ['InStock'], subtract: ['Committed'] });
    expect(strategy.normalizeAvailableFormula({ add: ['InStok'] }, { onInvalid })).toBeNull();
    expect(onInvalid).toHaveBeenCalledWith({ raw: { add: ['InStok'] }, reason: 'unknown_field:InStok' });
  });

  it('buildProperties aplica availableFormula y sin ella usa el default', () => {
    const strategy = new B1ItemWarehouseStrategy();
    const fields = strategy.normalizeFields([{ value: 'a01_stock', valueSAP: 'A01' }]);
    const record = { rawSapData: { ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', InStock: 10, Committed: 4, Ordered: 100 }] } };

    expect(strategy.buildProperties({ record, fields, availableFormula: { add: ['InStock'], subtract: ['Committed'] } }))
      .toEqual({ a01_stock: 6 });
    expect(strategy.buildProperties({ record, fields })).toEqual({ a01_stock: 106 });
  });
});
