import {
  parseODataDate,
  normalizeBatchExpiryConfig,
  S4BatchMasterStrategy,
} from '../../../src/domain/batches/sources/s4-batch-master.strategy.js';
import { BATCH_STATUS } from '../../../src/domain/batches/batch-expiry.constants.js';

const NOW = new Date('2026-08-13T00:00:00Z');
const strategy = new S4BatchMasterStrategy();

// Filas reales del S/4 de QA para el material 10000289 (ANHIDRIDO FTALICO).
const STOCK_ROWS = [
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0001', Batch: '17131', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '200.000' },
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0108', Batch: '17131', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '6000.000' },
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0001', Batch: '17141', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '8600.000' },
  { Material: '10000289', Plant: 'DPDO', StorageLocation: '0201', Batch: '17141', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '1054.000' },
  { Material: '10000289', Plant: 'MQDO', StorageLocation: '0108', Batch: '24J1', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '19000.000' },
];

const BATCH_ROWS = [
  { Material: '10000289', Batch: '17131', ShelfLifeExpirationDate: '/Date(1766707200000)/', ManufactureDate: null },
  { Material: '10000289', Batch: '17141', ShelfLifeExpirationDate: '/Date(1793491200000)/', ManufactureDate: null },
  { Material: '10000289', Batch: '24J1', ShelfLifeExpirationDate: null, ManufactureDate: null },
];

function resolve(config, { stockRows = STOCK_ROWS, batchRows = BATCH_ROWS } = {}) {
  const normalized = strategy.normalizeConfig(config);
  const index = strategy.buildIndex({ stockRows, batchRows }, { config: normalized, now: NOW });
  return strategy.resolveBatches({ record: { rawSapData: { Product: '10000289' } }, index });
}

describe('parseODataDate', () => {
  it('convierte el formato /Date(ms)/ de OData v2', () => {
    expect(parseODataDate('/Date(1766707200000)/').toISOString()).toBe('2025-12-26T00:00:00.000Z');
  });

  it('devuelve null para null, vacio y basura', () => {
    expect(parseODataDate(null)).toBeNull();
    expect(parseODataDate('')).toBeNull();
    expect(parseODataDate('no es una fecha')).toBeNull();
  });

  it('deja pasar un Date que ya venga construido', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    expect(parseODataDate(date)).toBe(date);
  });
});

describe('normalizeBatchExpiryConfig', () => {
  it('aplica los defaults cuando el valor viene vacio', () => {
    expect(normalizeBatchExpiryConfig(null)).toEqual({
      warehouses: [], stockTypes: ['01'], includeExpired: false, horizonDays: 90,
    });
  });

  it('parsea las bodegas con la misma gramatica que valueSAP', () => {
    expect(normalizeBatchExpiryConfig({ warehouses: ['DPDO/*', 'MQGT/0008', 'basura/a/b'] }).warehouses)
      .toEqual([
        { plant: 'DPDO', storageLocation: null },
        { plant: 'MQGT', storageLocation: '0008' },
      ]);
  });

  it('rechaza un horizonDays no numerico o negativo y cae al default', () => {
    expect(normalizeBatchExpiryConfig({ horizonDays: 'treinta' }).horizonDays).toBe(90);
    expect(normalizeBatchExpiryConfig({ horizonDays: -5 }).horizonDays).toBe(90);
    expect(normalizeBatchExpiryConfig({ horizonDays: 0 }).horizonDays).toBe(0);
  });
});

describe('S4BatchMasterStrategy.buildQueryTargets', () => {
  it('agrupa por centro, una entrada por Plant', () => {
    const config = strategy.normalizeConfig({ warehouses: ['DPDO/0001', 'DPDO/0201', 'MQGT/0008'] });
    expect(strategy.buildQueryTargets(config)).toEqual([
      { plant: 'DPDO', storageLocations: ['0001', '0201'] },
      { plant: 'MQGT', storageLocations: ['0008'] },
    ]);
  });

  it('el comodin de un centro gana sobre la lista explicita del mismo centro', () => {
    const config = strategy.normalizeConfig({ warehouses: ['DPDO/0001', 'DPDO/*'] });
    expect(strategy.buildQueryTargets(config)).toEqual([{ plant: 'DPDO', storageLocations: null }]);
  });

  it('sin bodegas configuradas devuelve [] (el resolver traera todos los centros)', () => {
    expect(strategy.buildQueryTargets(strategy.normalizeConfig({}))).toEqual([]);
  });
});

describe('S4BatchMasterStrategy.resolveBatches', () => {
  it('consolida un lote presente en dos almacenes en una sola entrada', () => {
    const batches = resolve({ warehouses: ['DPDO/*'] });
    const lote17131 = batches.find((b) => b.batch === '17131');

    expect(lote17131.quantity).toBe(6200);
    expect(lote17131.locations).toEqual([
      { plant: 'DPDO', storageLocation: '0001', quantity: 200 },
      { plant: 'DPDO', storageLocation: '0108', quantity: 6000 },
    ]);
  });

  it('REGRESION: no mezcla centros distintos — 24J1 vive en MQDO y DPDO/* no lo alcanza', () => {
    expect(resolve({ warehouses: ['DPDO/*'] }).map((b) => b.batch)).toEqual(['17131', '17141']);
  });

  it('REGRESION: el mismo codigo de almacen en dos centros son bodegas distintas', () => {
    const rows = [
      { Material: 'X', Plant: 'DPDO', StorageLocation: '0001', Batch: 'L1', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '10' },
      { Material: 'X', Plant: 'MQDO', StorageLocation: '0001', Batch: 'L1', InventoryStockType: '01', InventorySpecialStockType: '', MatlWrhsStkQtyInMatlBaseUnit: '99' },
    ];
    const normalized = strategy.normalizeConfig({ warehouses: ['DPDO/0001'] });
    const index = strategy.buildIndex({ stockRows: rows, batchRows: [] }, { config: normalized, now: NOW });
    const batches = strategy.resolveBatches({ record: { rawSapData: { Product: 'X' } }, index });

    expect(batches[0].quantity).toBe(10);
  });

  it('ordena por fecha ascendente y deja el lote sin fecha al final', () => {
    const batches = resolve({ warehouses: [] });
    expect(batches.map((b) => b.batch)).toEqual(['17131', '17141', '24J1']);
    expect(batches[2].status).toBe(BATCH_STATUS.SIN_FECHA);
  });

  it('clasifica contra el now inyectado', () => {
    // 17131 vence 2025-12-26 (pasado); 17141 vence 2026-11-01, a 80 dias del
    // NOW inyectado, o sea dentro del horizonte de 90.
    const batches = resolve({ warehouses: [], horizonDays: 90 });
    expect(batches[0].status).toBe(BATCH_STATUS.VENCIDO);
    expect(batches[1].status).toBe(BATCH_STATUS.POR_VENCER);
    expect(batches[1].daysToExpiry).toBe(80);
  });

  it('fuera del horizonte el mismo lote pasa a vigente', () => {
    const batches = resolve({ warehouses: [], horizonDays: 30 });
    expect(batches[1].status).toBe(BATCH_STATUS.VIGENTE);
  });

  it('descarta stock especial (consignacion / subcontratacion)', () => {
    const rows = [{ ...STOCK_ROWS[0], InventorySpecialStockType: 'W' }];
    expect(resolve({ warehouses: [] }, { stockRows: rows })).toEqual([]);
  });

  it('descarta tipos de stock fuera de los configurados', () => {
    const rows = [{ ...STOCK_ROWS[0], InventoryStockType: '02' }];
    expect(resolve({ warehouses: [], stockTypes: ['01'] }, { stockRows: rows })).toEqual([]);
    expect(resolve({ warehouses: [], stockTypes: ['01', '02'] }, { stockRows: rows })).toHaveLength(1);
  });

  it('descarta filas sin lote y con cantidad cero', () => {
    const rows = [
      { ...STOCK_ROWS[0], Batch: '' },
      { ...STOCK_ROWS[2], MatlWrhsStkQtyInMatlBaseUnit: '0.000' },
    ];
    expect(resolve({ warehouses: [] }, { stockRows: rows })).toEqual([]);
  });

  it('un lote con stock pero ausente del maestro queda sin fecha, no se pierde', () => {
    const batches = resolve({ warehouses: ['DPDO/0001'] }, { batchRows: [] });
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.status === BATCH_STATUS.SIN_FECHA)).toBe(true);
  });

  it('un material sin lotes en el indice devuelve []', () => {
    const index = strategy.buildIndex({ stockRows: STOCK_ROWS, batchRows: BATCH_ROWS }, { config: strategy.normalizeConfig({}), now: NOW });
    expect(strategy.resolveBatches({ record: { rawSapData: { Product: 'NO_EXISTE' } }, index })).toEqual([]);
  });

  it('redondea a 3 decimales para no romper la idempotencia', () => {
    const rows = [
      { ...STOCK_ROWS[0], MatlWrhsStkQtyInMatlBaseUnit: '4' },
      { ...STOCK_ROWS[1], MatlWrhsStkQtyInMatlBaseUnit: '4.000000000000002' },
    ];
    expect(resolve({ warehouses: [] }, { stockRows: rows })[0].quantity).toBe(8);
  });

  it('requiresRemoteFetch es true', () => {
    expect(strategy.requiresRemoteFetch()).toBe(true);
  });
});
