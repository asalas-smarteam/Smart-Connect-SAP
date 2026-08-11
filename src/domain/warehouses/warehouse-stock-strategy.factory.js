import {
  WAREHOUSE_STOCK_STRATEGIES,
} from './warehouse-stock-strategy.constants.js';

export class WarehouseStockStrategyFactory {
  constructor({
    b1ItemWarehouseStrategy,
    s4PlantStorageLocationStrategy,
    logger = console,
  }) {
    this.strategies = {
      [WAREHOUSE_STOCK_STRATEGIES.B1_ITEM_WAREHOUSE]: b1ItemWarehouseStrategy,
      [WAREHOUSE_STOCK_STRATEGIES.S4_PLANT_STORAGE_LOCATION]: s4PlantStorageLocationStrategy,
    };
    this.logger = logger;
  }

  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    if (Object.hasOwn(this.strategies, normalizedStrategyName)) {
      return this.strategies[normalizedStrategyName];
    }

    this.logger.error?.({
      msg: 'Warehouse stock strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(WAREHOUSE_STOCK_STRATEGIES),
    });

    throw new Error(`Warehouse stock strategy not supported: ${normalizedStrategyName}`);
  }
}

export default WarehouseStockStrategyFactory;
