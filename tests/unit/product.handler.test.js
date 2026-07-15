import { jest } from '@jest/globals';

const mockGetHubspotWarehouseStockPropertiesForTenant = jest.fn();
const mockBuildHubspotWarehouseStockProperties = jest.fn();
const mockResolveHubspotWarehouseFields = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/warehouseStock.js', () => ({
  getHubspotWarehouseStockPropertiesForTenant: mockGetHubspotWarehouseStockPropertiesForTenant,
  buildHubspotWarehouseStockProperties: mockBuildHubspotWarehouseStockProperties,
  resolveHubspotWarehouseFields: mockResolveHubspotWarehouseFields,
}));

const {
  preprocess,
  buildPreprocessContext,
  resolveHubspotPriceFields,
} = await import('../../src/infrastructure/hubspot/handlers/product.handler.js');

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

  it('preserves SAP-mapped price fields when the keepMappedPrice flag is set', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'fieldsPricesHS',
          value: ['hs_price_nio'],
          userUpdated: 'admin',
        }),
      },
    };
    const item = {
      properties: {
        hs_price_nio: 150,
      },
      rawSapData: {
        MovingAveragePrice: 150,
        keepMappedPrice: true,
        ItemWarehouseInfoCollection: [],
      },
    };

    await preprocess({ item, tenantModels });

    expect(item.properties).toEqual({
      A01_stock: 11,
      B10_stock: 4,
      hs_price_nio: 150,
    });
  });

  it('buildPreprocessContext resolves warehouse and price fields for the whole run', async () => {
    const warehouseFields = [{ warehouseCode: 'A01', propertyName: 'a01_stock' }];
    mockResolveHubspotWarehouseFields.mockResolvedValue(warehouseFields);
    const tenantModels = {
      Configuration: {
        findOne: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            key: 'fieldsPricesHS',
            value: ['hs_price_nio'],
          }),
        }),
      },
    };

    const context = await buildPreprocessContext({ tenantModels });

    expect(context).toEqual({
      warehouseFields,
      priceFields: ['hs_price_nio'],
    });
    expect(mockResolveHubspotWarehouseFields).toHaveBeenCalledWith(tenantModels);
  });

  it('preprocess uses the preprocessContext without touching the database', async () => {
    const warehouseFields = [{ warehouseCode: 'A01', propertyName: 'A01_stock' }];
    mockBuildHubspotWarehouseStockProperties.mockReturnValue({ A01_stock: 7 });
    const tenantModels = {
      Configuration: {
        findOne: jest.fn(),
        findOneAndUpdate: jest.fn(),
      },
    };
    const item = {
      properties: {},
      rawSapData: {
        ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', InStock: 7 }],
      },
    };

    await preprocess({
      item,
      tenantModels,
      preprocessContext: { warehouseFields, priceFields: ['hs_price_nio'] },
    });

    expect(item.properties).toEqual({
      A01_stock: 7,
      hs_price_nio: 0,
    });
    expect(mockBuildHubspotWarehouseStockProperties).toHaveBeenCalledWith(
      item.rawSapData.ItemWarehouseInfoCollection,
      warehouseFields
    );
    expect(mockGetHubspotWarehouseStockPropertiesForTenant).not.toHaveBeenCalled();
    expect(tenantModels.Configuration.findOne).not.toHaveBeenCalled();
    expect(tenantModels.Configuration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('preserves strategy price fields when product has a selected SAP price', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'fieldsPricesHS',
          value: ['price'],
          userUpdated: 'admin',
        }),
      },
    };
    const item = {
      properties: {
        price: 120,
      },
      rawSapData: {
        selectedPrice: { Price: 120, PriceList: 1 },
        ItemWarehouseInfoCollection: [],
      },
    };

    await preprocess({ item, tenantModels });

    expect(item.properties).toEqual({
      A01_stock: 11,
      B10_stock: 4,
      price: 120,
    });
  });
});
