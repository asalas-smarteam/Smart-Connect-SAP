import { jest } from '@jest/globals';
import ProductSyncStrategyFactory from '../../../src/domain/products/product-sync-strategy.factory.js';
import {
  PRODUCT_SYNC_STRATEGIES,
} from '../../../src/domain/products/product-sync-strategy.constants.js';
import OneToManyProductStrategy from '../../../src/domain/products/strategies/one-to-many-product.strategy.js';

describe('ProductSyncStrategyFactory', () => {
  it('rejects unsupported product sync strategies', () => {
    const factory = new ProductSyncStrategyFactory({
      oneToOneProductStrategy: {},
      oneToManyProductStrategy: {},
      logger: { error: jest.fn() },
    });

    expect(() => factory.getStrategy('missing_strategy'))
      .toThrow('Product sync strategy not supported: missing_strategy');
  });
});

describe('OneToManyProductStrategy', () => {
  it('expands one SAP product into one HubSpot product per configured price list', async () => {
    const hubspotSyncTarget = {
      send: jest.fn().mockResolvedValue({ sent: 2, failed: 0 }),
    };
    const sapPriceProvider = {
      getItemPricesByPriceLists: jest.fn().mockResolvedValue(new Map([
        ['1', { Price: 120, Currency: 'USD', PriceList: 1 }],
        ['2', { Price: 150, Currency: 'USD', PriceList: 2 }],
      ])),
    };
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const strategy = new OneToManyProductStrategy({
      hubspotSyncTarget,
      sapPriceProvider,
      logger,
    });

    const result = await strategy.execute({
      mappedRecords: [
        {
          properties: {
            hs_sku: 'MANZANA001',
            name: 'Manzana',
            quantity: 10,
          },
          rawSapData: {
            ItemCode: 'MANZANA001',
            ItemName: 'Manzana',
          },
        },
      ],
      config: { hubspotCredentialId: 'cred-1' },
      objectType: 'product',
      tenantModels: {},
      credentials: { _id: 'cred-1' },
      tenantId: 'tenant-1',
      strategyConfig: {
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
        priceLists: [
          { name: 'VIP', value: '1' },
          { name: 'Publico', value: '2' },
        ],
      },
    });

    expect(result).toEqual({ sent: 2, failed: 0, recordsProcessed: 2 });
    expect(sapPriceProvider.getItemPricesByPriceLists).toHaveBeenCalledWith(expect.objectContaining({
      itemCode: 'MANZANA001',
    }));
    expect(hubspotSyncTarget.send).toHaveBeenCalledWith(expect.objectContaining({
      mappedRecords: [
        expect.objectContaining({
          properties: expect.objectContaining({
            hs_sku: 'MANZANA001__PL_1',
            name: 'Manzana - VIP',
            sap_base_item_code: 'MANZANA001',
            price_list_name: 'VIP',
            price_list_value: '1',
            price: 120,
          }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            hs_sku: 'MANZANA001__PL_2',
            name: 'Manzana - Publico',
            sap_base_item_code: 'MANZANA001',
            price_list_name: 'Publico',
            price_list_value: '2',
            price: 150,
          }),
        }),
      ],
    }));
  });

  it('uses zero when SAP does not return a configured price list by default', async () => {
    const hubspotSyncTarget = {
      send: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }),
    };
    const strategy = new OneToManyProductStrategy({
      hubspotSyncTarget,
      sapPriceProvider: {
        getItemPricesByPriceLists: jest.fn().mockResolvedValue(new Map()),
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    const result = await strategy.execute({
      mappedRecords: [
        {
          properties: { hs_sku: 'SKU-1', name: 'Producto' },
          rawSapData: { ItemCode: 'SKU-1', ItemName: 'Producto' },
        },
      ],
      config: {},
      objectType: 'product',
      tenantModels: {},
      credentials: {},
      strategyConfig: {
        priceLists: [{ name: 'VIP', value: '1' }],
      },
    });

    expect(result).toEqual({ sent: 1, failed: 0, recordsProcessed: 1 });
    expect(hubspotSyncTarget.send).toHaveBeenCalledWith(expect.objectContaining({
      mappedRecords: [
        expect.objectContaining({
          properties: expect.objectContaining({
            hs_sku: 'SKU-1__PL_1',
            price: 0,
          }),
        }),
      ],
    }));
  });
});
