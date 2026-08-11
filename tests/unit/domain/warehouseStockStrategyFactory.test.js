import { jest } from '@jest/globals';
import WarehouseStockStrategyFactory from '../../../src/domain/warehouses/warehouse-stock-strategy.factory.js';
import { WAREHOUSE_STOCK_STRATEGIES } from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';

describe('WarehouseStockStrategyFactory', () => {
  const b1ItemWarehouseStrategy = { name: 'b1' };
  const s4PlantStorageLocationStrategy = { name: 's4' };

  it('resolves the B1 strategy by name', () => {
    const factory = new WarehouseStockStrategyFactory({
      b1ItemWarehouseStrategy,
      s4PlantStorageLocationStrategy,
    });

    expect(factory.getStrategy(WAREHOUSE_STOCK_STRATEGIES.B1_ITEM_WAREHOUSE)).toBe(b1ItemWarehouseStrategy);
  });

  it('resolves the S/4 strategy by name', () => {
    const factory = new WarehouseStockStrategyFactory({
      b1ItemWarehouseStrategy,
      s4PlantStorageLocationStrategy,
    });

    expect(factory.getStrategy(WAREHOUSE_STOCK_STRATEGIES.S4_PLANT_STORAGE_LOCATION))
      .toBe(s4PlantStorageLocationStrategy);
  });

  it('throws with the list of valid strategies for an unknown name', () => {
    const logger = { error: jest.fn() };
    const factory = new WarehouseStockStrategyFactory({
      b1ItemWarehouseStrategy,
      s4PlantStorageLocationStrategy,
      logger,
    });

    expect(() => factory.getStrategy('nope')).toThrow('Warehouse stock strategy not supported: nope');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      strategyName: 'nope',
      validStrategies: Object.values(WAREHOUSE_STOCK_STRATEGIES),
    }));
  });
});
