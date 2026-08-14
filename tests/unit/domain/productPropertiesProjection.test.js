import { jest } from '@jest/globals';
import ProductPropertiesProjection, {
  BATCH_PRODUCT_PROPERTIES,
  formatQuantity,
  formatDate,
} from '../../../src/domain/batches/projections/product-properties.projection.js';
import BatchProjectionStrategyFactory from '../../../src/domain/batches/batch-projection-strategy.factory.js';
import { BATCH_STATUS, BATCH_PROJECTION_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';
import { ProductBatchProjectionPort } from '../../../src/application/ports/hubspot/product-batch-projection.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const projection = new ProductPropertiesProjection();

const VENCIDO = {
  batch: '17131', expirationDate: new Date('2025-12-26T00:00:00Z'), quantity: 6200,
  locations: [
    { plant: 'DPDO', storageLocation: '0001', quantity: 200 },
    { plant: 'DPDO', storageLocation: '0108', quantity: 6000 },
  ],
  status: BATCH_STATUS.VENCIDO, daysToExpiry: -230,
};
const POR_VENCER = {
  batch: '17141', expirationDate: new Date('2026-11-01T00:00:00Z'), quantity: 9654,
  locations: [
    { plant: 'DPDO', storageLocation: '0001', quantity: 8600 },
    { plant: 'DPDO', storageLocation: '0201', quantity: 1054 },
  ],
  status: BATCH_STATUS.POR_VENCER, daysToExpiry: 80,
};
const SIN_FECHA = {
  batch: '24J1', expirationDate: null, quantity: 19000,
  locations: [{ plant: 'MQDO', storageLocation: '0108', quantity: 19000 }],
  status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null,
};

const config = { includeExpired: false, horizonDays: 90 };

describe('formatQuantity / formatDate', () => {
  it('formatea con separador de miles y 3 decimales, sin depender del ICU', () => {
    expect(formatQuantity(9654)).toBe('9,654.000');
    expect(formatQuantity(200)).toBe('200.000');
    expect(formatQuantity(1234567.5)).toBe('1,234,567.500');
  });

  it('formatea la fecha como YYYY-MM-DD en UTC', () => {
    expect(formatDate(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-01');
  });
});

describe('ProductPropertiesProjection', () => {
  it('cumple el puerto completo', () => {
    expect(() => assertPort(projection, ProductBatchProjectionPort)).not.toThrow();
  });

  it('requiredProperties declara las 7 propiedades sobre products', () => {
    const properties = projection.requiredProperties();
    expect(properties).toHaveLength(7);
    expect(properties.map((p) => p.name).sort()).toEqual([
      'cantidad_por_vencer', 'cantidad_vencida', 'dias_para_vencer',
      'fecha_vencimiento_proxima', 'lote_proximo_vencer', 'lotes_detalle', 'lotes_vigentes',
    ]);
    expect(properties.every((p) => p.objectType === 'products')).toBe(true);
    expect(properties).toBe(BATCH_PRODUCT_PROPERTIES);
  });

  it('renderiza una linea por lote con bodegas listadas', () => {
    const { lotes_detalle: detalle } = projection.project({ batches: [POR_VENCER], config });
    expect(detalle).toBe('17141 · vence 2026-11-01 · 9,654.000 · DPDO/0001, DPDO/0201');
  });

  it('marca el lote sin fecha en vez de omitirlo', () => {
    const { lotes_detalle: detalle } = projection.project({ batches: [SIN_FECHA], config });
    expect(detalle).toBe('24J1 · sin fecha · 19,000.000 · MQDO/0108');
  });

  it('con includeExpired false el detalle NO trae vencidos', () => {
    const { lotes_detalle: detalle } = projection.project({ batches: [VENCIDO, POR_VENCER], config });
    expect(detalle).not.toContain('17131');
    expect(detalle).toContain('17141');
  });

  it('con includeExpired true el detalle los trae marcados', () => {
    const { lotes_detalle: detalle } = projection.project({
      batches: [VENCIDO, POR_VENCER], config: { ...config, includeExpired: true },
    });
    expect(detalle.split('\n')[0]).toBe('17131 · VENCIDO 2025-12-26 · 6,200.000 · DPDO/0001, DPDO/0108');
  });

  it('cantidad_vencida se llena aunque includeExpired sea false', () => {
    const properties = projection.project({ batches: [VENCIDO, POR_VENCER], config });
    expect(properties.cantidad_vencida).toBe(6200);
  });

  it('fecha_vencimiento_proxima ignora los vencidos aun con includeExpired true', () => {
    const properties = projection.project({
      batches: [VENCIDO, POR_VENCER], config: { ...config, includeExpired: true },
    });
    expect(properties.lote_proximo_vencer).toBe('17141');
    expect(properties.fecha_vencimiento_proxima).toBe('2026-11-01');
    expect(properties.dias_para_vencer).toBe(80);
  });

  it('sin lotes escribe las 7 propiedades VACIAS, nunca en cero', () => {
    const properties = projection.project({ batches: [], config });
    expect(Object.keys(properties).sort()).toEqual([
      'cantidad_por_vencer', 'cantidad_vencida', 'dias_para_vencer',
      'fecha_vencimiento_proxima', 'lote_proximo_vencer', 'lotes_detalle', 'lotes_vigentes',
    ]);
    expect(Object.values(properties).every((value) => value === '')).toBe(true);
  });

  it('solo vencidos: escalares de vigencia vacios pero cantidad_vencida poblada', () => {
    const properties = projection.project({ batches: [VENCIDO], config });
    expect(properties.lote_proximo_vencer).toBe('');
    expect(properties.fecha_vencimiento_proxima).toBe('');
    expect(properties.dias_para_vencer).toBe('');
    expect(properties.cantidad_vencida).toBe(6200);
    expect(properties.lotes_vigentes).toBe(0);
  });
});

describe('BatchProjectionStrategyFactory', () => {
  it('resuelve la proyeccion a propiedades del producto', () => {
    const factory = new BatchProjectionStrategyFactory({
      productPropertiesProjection: projection, logger: console,
    });
    expect(factory.getStrategy(BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES)).toBe(projection);
  });

  it('lanza y loguea las proyecciones validas cuando el nombre no existe', () => {
    const logger = { error: jest.fn() };
    const factory = new BatchProjectionStrategyFactory({
      productPropertiesProjection: projection, logger,
    });
    expect(() => factory.getStrategy('hs_CustomObject')).toThrow('Batch projection strategy not supported: hs_CustomObject');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      validStrategies: Object.values(BATCH_PROJECTION_STRATEGIES),
    }));
  });
});
