// src/domain/batches/batch-source-strategy.factory.js
import { BATCH_SOURCE_STRATEGIES } from './batch-expiry.constants.js';

export class BatchSourceStrategyFactory {
  constructor({ noneStrategy, s4BatchMasterStrategy, logger = console }) {
    this.strategies = {
      [BATCH_SOURCE_STRATEGIES.NONE]: noneStrategy,
      [BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER]: s4BatchMasterStrategy,
    };
    this.logger = logger;
  }

  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    // Mismo par de condiciones que WarehouseStockStrategyFactory: hasOwn para no
    // resolver 'constructor'/'toString' por la cadena de prototipos, y el truthy
    // para no devolver undefined si la strategy no se inyecto en composicion.
    const strategy = Object.hasOwn(this.strategies, normalizedStrategyName)
      && this.strategies[normalizedStrategyName];

    if (strategy) {
      return strategy;
    }

    this.logger.error?.({
      msg: 'Batch source strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(BATCH_SOURCE_STRATEGIES),
    });

    throw new Error(`Batch source strategy not supported: ${normalizedStrategyName}`);
  }
}

export default BatchSourceStrategyFactory;
