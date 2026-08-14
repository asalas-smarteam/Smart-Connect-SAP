// tests/unit/domain/batchSourceStrategyFactory.test.js
import { jest } from '@jest/globals';
import BatchSourceStrategyFactory from '../../../src/domain/batches/batch-source-strategy.factory.js';
import NoneBatchSourceStrategy from '../../../src/domain/batches/sources/none.strategy.js';
import { BATCH_SOURCE_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';
import { BatchSourceStrategyPort } from '../../../src/application/ports/sap/batch-source-strategy.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

function buildFactory(logger) {
  return new BatchSourceStrategyFactory({
    noneStrategy: new NoneBatchSourceStrategy(),
    s4BatchMasterStrategy: { marker: 's4' },
    logger,
  });
}

describe('BatchSourceStrategyFactory', () => {
  it('resuelve cada nombre declarado en las constantes', () => {
    const factory = buildFactory(console);
    expect(factory.getStrategy(BATCH_SOURCE_STRATEGIES.NONE)).toBeInstanceOf(NoneBatchSourceStrategy);
    expect(factory.getStrategy(BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER)).toEqual({ marker: 's4' });
  });

  it('recorta espacios alrededor del nombre', () => {
    expect(buildFactory(console).getStrategy('  none  ')).toBeInstanceOf(NoneBatchSourceStrategy);
  });

  it('lanza y loguea las estrategias validas cuando el nombre no existe', () => {
    const logger = { error: jest.fn() };
    expect(() => buildFactory(logger).getStrategy('inventada')).toThrow('Batch source strategy not supported: inventada');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      strategyName: 'inventada',
      validStrategies: Object.values(BATCH_SOURCE_STRATEGIES),
    }));
  });

  it('no resuelve nombres heredados de Object.prototype', () => {
    expect(() => buildFactory(console).getStrategy('constructor')).toThrow('not supported');
  });
});

describe('NoneBatchSourceStrategy', () => {
  it('cumple el puerto completo', () => {
    expect(() => assertPort(new NoneBatchSourceStrategy(), BatchSourceStrategyPort)).not.toThrow();
  });

  it('no pide nada a SAP y no devuelve lotes', () => {
    const strategy = new NoneBatchSourceStrategy();
    expect(strategy.requiresRemoteFetch()).toBe(false);
    expect(strategy.buildQueryTargets({})).toEqual([]);
    expect(strategy.buildIndex({ stockRows: [{ Material: '1' }], batchRows: [] })).toEqual(new Map());
    expect(strategy.resolveBatches({ record: {}, index: new Map() })).toEqual([]);
  });
});
