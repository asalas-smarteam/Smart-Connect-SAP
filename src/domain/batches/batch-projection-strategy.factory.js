import { BATCH_PROJECTION_STRATEGIES } from './batch-expiry.constants.js';

export class BatchProjectionStrategyFactory {
  constructor({ productPropertiesProjection, logger = console }) {
    this.strategies = {
      [BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES]: productPropertiesProjection,
    };
    this.logger = logger;
  }

  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    const strategy = Object.hasOwn(this.strategies, normalizedStrategyName)
      && this.strategies[normalizedStrategyName];

    if (strategy) {
      return strategy;
    }

    this.logger.error?.({
      msg: 'Batch projection strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(BATCH_PROJECTION_STRATEGIES),
    });

    throw new Error(`Batch projection strategy not supported: ${normalizedStrategyName}`);
  }
}

export default BatchProjectionStrategyFactory;
