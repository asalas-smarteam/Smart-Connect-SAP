import {
  PRODUCT_SYNC_STRATEGIES,
} from './product-sync-strategy.constants.js';

export class ProductSyncStrategyFactory {
  constructor({
    oneToOneProductStrategy,
    oneToManyProductStrategy,
    logger = console,
  }) {
    this.strategies = {
      [PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT]: oneToOneProductStrategy,
      [PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT]: oneToManyProductStrategy,
    };
    this.logger = logger;
  }

  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    if (Object.hasOwn(this.strategies, normalizedStrategyName)) {
      return this.strategies[normalizedStrategyName];
    }

    this.logger.error?.({
      msg: 'Product sync strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(PRODUCT_SYNC_STRATEGIES),
    });

    throw new Error(`Product sync strategy not supported: ${normalizedStrategyName}`);
  }
}

export default ProductSyncStrategyFactory;
