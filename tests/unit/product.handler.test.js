import { jest } from '@jest/globals';

const mockGetHubspotWarehouseStockPropertiesForTenant = jest.fn();

jest.unstable_mockModule('../../src/utils/warehouseStock.js', () => ({
  getHubspotWarehouseStockPropertiesForTenant: mockGetHubspotWarehouseStockPropertiesForTenant,
}));

const { preprocess, resolveHubspotPriceFields } = await import('../../src/services/hubspot/handlers/product.handler.js');

describe('product.handler preprocess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHubspotWarehouseStockPropertiesForTenant.mockResolvedValue({
      A01_stock: 11,
      B10_stock: 4,
    });
  });

  it('sets all configured HubSpot price fields to zero', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'fieldsPricesHS',
          value: ['hs_price_usd', ' hs_price_nio ', '', 'hs_price_usd'],
          userUpdated: 'admin',
        }),
      },
    };
    const item = {
      properties: {},
      rawSapData: {
        ItemWarehouseInfoCollection: [],
      },
    };

    await preprocess({ item, tenantModels });

    expect(item.properties).toEqual({
      A01_stock: 11,
      B10_stock: 4,
      hs_price_usd: 0,
      hs_price_nio: 0,
    });
    expect(tenantModels.Configuration.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'fieldsPricesHS' },
      {
        $setOnInsert: {
          key: 'fieldsPricesHS',
          value: ['hs_price_usd'],
          userUpdated: 'admin',
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  });

  it('falls back to default price field when config value is invalid', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'fieldsPricesHS',
          value: 'hs_price_crc',
          userUpdated: 'admin',
        }),
      },
    };

    const fields = await resolveHubspotPriceFields(tenantModels);

    expect(fields).toEqual(['hs_price_usd']);
  });
});
