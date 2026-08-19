import {
  parseODataDate,
  normalizeBatchExpiryConfig,
  S4BatchMasterStrategy,
} from '../../../src/domain/batches/sources/s4-batch-master.strategy.js';
import { BATCH_STATUS } from '../../../src/domain/batches/batch-expiry.constants.js';
import { normalizeODataV2Response } from '../../../src/infrastructure/sap/transport/odataV2Normalizer.js';

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

  // REGRESION: esta es la forma que llega en produccion. El transporte ya
  // convirtio /Date(ms)/ a ISO antes de que la fila entre a buildIndex, y
  // aceptar solo la forma cruda dejaba TODAS las fechas en null: los productos
  // salian con "sin fecha" en lotes_detalle y las cuatro propiedades escalares
  // de vencimiento vacias, sin ningun error en el log.
  it('convierte el ISO-8601 que emite el normalizador del transporte', () => {
    expect(parseODataDate('2030-11-01T00:00:00.000Z').toISOString())
      .toBe('2030-11-01T00:00:00.000Z');
    expect(parseODataDate('2030-11-01').toISOString()).toBe('2030-11-01T00:00:00.000Z');
  });

  it('devuelve null para null, vacio y basura', () => {
    expect(parseODataDate(null)).toBeNull();
    expect(parseODataDate('')).toBeNull();
    expect(parseODataDate('no es una fecha')).toBeNull();
  });

  // new Date('1160.000') NO es invalida: es el ano 1160. Sin el guardia de
  // forma ISO, una cantidad mal ruteada se leeria como un lote vencido hace
  // nueve siglos en vez de quedar como "sin fecha".
  it('no acepta un numero suelto como fecha', () => {
    expect(parseODataDate('1160.000')).toBeNull();
    expect(parseODataDate('2030')).toBeNull();
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

  // REGRESION: antes devolvia [], y con [] el resolver no hacia NINGUNA llamada
  // -- el indice salia vacio y la proyeccion escribia las siete propiedades en
  // blanco sobre los 8,080 productos. "Bodegas vacias = todas" tiene que llegar
  // hasta el fetch, no quedarse en el filtro de dominio.
  it('sin bodegas configuradas devuelve UN target explicito de todos los centros', () => {
    expect(strategy.buildQueryTargets(strategy.normalizeConfig({}))).toEqual([
      { plant: null, storageLocations: null, allPlants: true },
    ]);
  });

  it('nunca devuelve [] para una config sin bodegas (ni con warehouses basura)', () => {
    expect(strategy.buildQueryTargets(strategy.normalizeConfig({ warehouses: [] }))).toHaveLength(1);
    expect(strategy.buildQueryTargets(strategy.normalizeConfig({ warehouses: ['basura/a/b'] })))
      .toHaveLength(1);
  });

  it('con bodegas configuradas NO marca allPlants en ningun target', () => {
    const config = strategy.normalizeConfig({ warehouses: ['DPDO/*'] });
    expect(strategy.buildQueryTargets(config).some((t) => t.allPlants)).toBe(false);
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

// El resto de este archivo alimenta buildIndex con fixtures escritas a mano en
// el formato CRUDO de Gateway, que es justamente lo que la estrategia nunca ve:
// S4BatchResolver.fetchBatchRows delega en transport.fetchAll, y fetchAll pasa
// cada pagina por normalizeODataV2Response. Este bloque cierra esa costura
// haciendo correr el normalizador REAL sobre una respuesta REAL del S/4 de QA.
describe('S4BatchMasterStrategy contra la salida real del transporte', () => {
  // Respuesta textual de API_BATCH_SRV/Batch y A_MatlStkInAcctMod para el
  // material 80003291, capturada del S/4 de QA el 2026-08-18.
  const GATEWAY_BATCH_PAYLOAD = {
    d: {
      results: [
        {
          __metadata: { id: "…Batch(Material='80003291',BatchIdentifyingPlant='',Batch='0000026047')", type: 'cds_api_batch_srv.BatchType' },
          Material: '80003291', BatchIdentifyingPlant: '', Batch: '0000026047',
          ShelfLifeExpirationDate: '/Date(1919721600000)/', ManufactureDate: '/Date(1764201600000)/',
        },
        {
          __metadata: { id: "…Batch(Material='80003291',BatchIdentifyingPlant='',Batch='OFFGRADE')", type: 'cds_api_batch_srv.BatchType' },
          Material: '80003291', BatchIdentifyingPlant: '', Batch: 'OFFGRADE',
          ShelfLifeExpirationDate: null, ManufactureDate: null,
        },
      ],
    },
  };

  const GATEWAY_STOCK_PAYLOAD = {
    d: {
      results: [
        {
          __metadata: { type: 'API_MATERIAL_STOCK_SRV.A_MatlStkInAcctModType' },
          Material: '80003291', Plant: 'CPDO', StorageLocation: '0203', Batch: '0000026047',
          InventorySpecialStockType: '', InventoryStockType: '01',
          MatlWrhsStkQtyInMatlBaseUnit: '1160.000',
        },
        {
          __metadata: { type: 'API_MATERIAL_STOCK_SRV.A_MatlStkInAcctModType' },
          Material: '80003291', Plant: 'CPDO', StorageLocation: '0203', Batch: 'OFFGRADE',
          InventorySpecialStockType: '', InventoryStockType: '01',
          MatlWrhsStkQtyInMatlBaseUnit: '7073.500',
        },
      ],
    },
  };

  function resolveThroughTransport() {
    const config = strategy.normalizeConfig({});
    const index = strategy.buildIndex(
      {
        stockRows: normalizeODataV2Response(GATEWAY_STOCK_PAYLOAD),
        batchRows: normalizeODataV2Response(GATEWAY_BATCH_PAYLOAD),
      },
      { config, now: NOW }
    );
    return strategy.resolveBatches({ record: { rawSapData: { Product: '80003291' } }, index });
  }

  it('el normalizador entrega ISO, no /Date(ms)/ — la premisa de este bloque', () => {
    const [row] = normalizeODataV2Response(GATEWAY_BATCH_PAYLOAD);
    expect(row.ShelfLifeExpirationDate).toBe('2030-11-01T00:00:00.000Z');
  });

  // REGRESION del primer run contra el S/4 de QA: el lote llegaba con cantidad
  // y bodega correctas pero SIN fecha, porque parseODataDate solo aceptaba la
  // forma cruda. HubSpot quedo con lotes_detalle en "sin fecha" y
  // fecha_vencimiento_proxima / dias_para_vencer / lote_proximo_vencer en null.
  it('conserva la fecha de caducidad al pasar por el normalizador real', () => {
    const [lote] = resolveThroughTransport();

    expect(lote.batch).toBe('0000026047');
    expect(lote.expirationDate).toBeInstanceOf(Date);
    expect(lote.expirationDate.toISOString().slice(0, 10)).toBe('2030-11-01');
    expect(lote.status).not.toBe(BATCH_STATUS.SIN_FECHA);
    expect(lote.daysToExpiry).toBeGreaterThan(0);
  });

  it('el lote que de verdad no tiene fecha en el maestro sigue quedando sin fecha', () => {
    const offgrade = resolveThroughTransport().find((b) => b.batch === 'OFFGRADE');

    expect(offgrade.expirationDate).toBeNull();
    expect(offgrade.status).toBe(BATCH_STATUS.SIN_FECHA);
  });
});
