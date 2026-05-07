import { jest } from '@jest/globals';
import ProductSyncStrategyConfigRepository from '../../../src/infrastructure/config/ProductSyncStrategyConfigRepository.js';
import {
  PRODUCT_SYNC_STRATEGIES,
} from '../../../src/domain/products/product-sync-strategy.constants.js';

describe('ProductSyncStrategyConfigRepository', () => {
  it('returns oneToOne_Product when Configuration model is not available', async () => {
    const repository = new ProductSyncStrategyConfigRepository();

    await expect(repository.getProductSyncStrategyConfig({ tenantModels: {} }))
      .resolves.toEqual({ strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT });
  });

  it('parses JSON string strategy configuration', async () => {
    const repository = new ProductSyncStrategyConfigRepository();
    const lean = jest.fn().mockResolvedValue({
      value: JSON.stringify({
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
        priceLists: [{ name: 'VIP', value: '1' }],
      }),
    });
    const tenantModels = {
      Configuration: {
        findOne: jest.fn().mockReturnValue({ lean }),
      },
    };

    await expect(repository.getProductSyncStrategyConfig({ tenantModels }))
      .resolves.toEqual({
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
        priceLists: [{ name: 'VIP', value: '1' }],
      });
  });
});
