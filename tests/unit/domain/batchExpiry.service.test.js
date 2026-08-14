import {
  daysBetween,
  classifyBatch,
  sortBatches,
  summarizeBatches,
  roundQuantity,
} from '../../../src/domain/batches/batch-expiry.service.js';
import { BATCH_STATUS } from '../../../src/domain/batches/batch-expiry.constants.js';

const NOW = new Date('2026-08-13T14:37:00Z');

describe('daysBetween', () => {
  it('ignora la hora del dia: compara medianoche UTC contra medianoche UTC', () => {
    expect(daysBetween(NOW, new Date('2026-08-14T00:01:00Z'))).toBe(1);
    expect(daysBetween(NOW, new Date('2026-08-13T23:59:00Z'))).toBe(0);
    expect(daysBetween(NOW, new Date('2026-08-12T23:59:00Z'))).toBe(-1);
  });
});

describe('classifyBatch', () => {
  it('sin fecha -> sinFecha, con daysToExpiry null', () => {
    expect(classifyBatch({ expirationDate: null, now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null });
  });

  it('fecha pasada -> vencido', () => {
    expect(classifyBatch({ expirationDate: new Date('2021-12-22T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.VENCIDO, daysToExpiry: -1695 });
  });

  it('hoy mismo todavia no esta vencido', () => {
    expect(classifyBatch({ expirationDate: new Date('2026-08-13T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.POR_VENCER, daysToExpiry: 0 });
  });

  it('exactamente en el horizonte cuenta como porVencer (borde inclusivo)', () => {
    expect(classifyBatch({ expirationDate: new Date('2026-11-11T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.POR_VENCER, daysToExpiry: 90 });
  });

  it('un dia despues del horizonte ya es vigente', () => {
    expect(classifyBatch({ expirationDate: new Date('2026-11-12T00:00:00Z'), now: NOW, horizonDays: 90 }))
      .toEqual({ status: BATCH_STATUS.VIGENTE, daysToExpiry: 91 });
  });
});

describe('sortBatches', () => {
  it('ordena por fecha ascendente y manda los sin fecha al final', () => {
    const sorted = sortBatches([
      { batch: 'C', expirationDate: null },
      { batch: 'B', expirationDate: new Date('2026-12-01T00:00:00Z') },
      { batch: 'A', expirationDate: new Date('2026-09-01T00:00:00Z') },
    ]);

    expect(sorted.map((b) => b.batch)).toEqual(['A', 'B', 'C']);
  });

  it('no muta el arreglo original', () => {
    const input = [
      { batch: 'B', expirationDate: new Date('2026-12-01T00:00:00Z') },
      { batch: 'A', expirationDate: new Date('2026-09-01T00:00:00Z') },
    ];
    sortBatches(input);
    expect(input.map((b) => b.batch)).toEqual(['B', 'A']);
  });
});

describe('summarizeBatches', () => {
  const batches = [
    { batch: 'VIEJO', quantity: 100, status: BATCH_STATUS.VENCIDO, daysToExpiry: -900, expirationDate: new Date('2024-02-25T00:00:00Z') },
    { batch: 'PRONTO', quantity: 50, status: BATCH_STATUS.POR_VENCER, daysToExpiry: 10, expirationDate: new Date('2026-08-23T00:00:00Z') },
    { batch: 'LEJOS', quantity: 25, status: BATCH_STATUS.VIGENTE, daysToExpiry: 400, expirationDate: new Date('2027-09-17T00:00:00Z') },
    { batch: 'NADA', quantity: 7, status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null, expirationDate: null },
  ];

  it('el proximo a vencer nunca es uno vencido', () => {
    expect(summarizeBatches(batches).proximo.batch).toBe('PRONTO');
  });

  it('suma por vencer y vencida por separado', () => {
    const summary = summarizeBatches(batches);
    expect(summary.cantidadPorVencer).toBe(50);
    expect(summary.cantidadVencida).toBe(100);
  });

  it('lotes vigentes cuenta todo lo que no esta vencido', () => {
    expect(summarizeBatches(batches).lotesVigentes).toBe(3);
  });

  it('sin lotes devuelve proximo null y ceros', () => {
    expect(summarizeBatches([])).toEqual({
      proximo: null, cantidadPorVencer: 0, cantidadVencida: 0, lotesVigentes: 0,
    });
  });

  it('solo vencidos: proximo null pero cantidadVencida poblada', () => {
    const summary = summarizeBatches([batches[0]]);
    expect(summary.proximo).toBeNull();
    expect(summary.cantidadVencida).toBe(100);
  });
});

describe('roundQuantity', () => {
  it('mata el ruido de punto flotante que rompe la idempotencia', () => {
    expect(roundQuantity(4 + 4 + 4.000000000000002)).toBe(12);
    expect(roundQuantity('8600.5')).toBe(8600.5);
    expect(roundQuantity(undefined)).toBe(0);
  });
});
