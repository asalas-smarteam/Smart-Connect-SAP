import { jest } from '@jest/globals';
import { WAREHOUSE_STOCK_KEY } from '../../src/domain/warehouses/warehouse-stock-strategy.constants.js';
import { BATCH_EXPIRY_KEY } from '../../src/domain/batches/batch-expiry.constants.js';

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

  describe('_warehouseStock set by WarehouseStockEnrichmentAdapter', () => {
    it('uses the pre-resolved stock properties verbatim and skips the B1 lookup', async () => {
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
        properties: {},
        rawSapData: {
          _warehouseStock: { mqgt_0008_stock: 12, dpdo_stock: 0 },
          // Present but must be ignored: on S/4 there is no
          // ItemWarehouseInfoCollection at all, but even if there were, the
          // _warehouseStock key must win.
          ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', InStock: 999 }],
        },
      };

      await preprocess({ item, tenantModels });

      expect(item.properties).toEqual({
        mqgt_0008_stock: 12,
        dpdo_stock: 0,
        price: 0,
      });
      expect(mockBuildHubspotWarehouseStockProperties).not.toHaveBeenCalled();
      expect(mockGetHubspotWarehouseStockPropertiesForTenant).not.toHaveBeenCalled();
    });

    it('writes no warehouse properties when the resolved stock is empty', async () => {
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
        properties: {},
        rawSapData: { _warehouseStock: {} },
      };

      await preprocess({ item, tenantModels });

      expect(item.properties).toEqual({ price: 0 });
      expect(mockGetHubspotWarehouseStockPropertiesForTenant).not.toHaveBeenCalled();
    });
  });

  describe('mutually exclusive discount properties', () => {
    const preprocessContext = { warehouseFields: [], priceFields: [] };

    beforeEach(() => {
      mockBuildHubspotWarehouseStockProperties.mockReturnValue({});
    });

    function buildItem(discountHsProperty, resolvedDiscount) {
      return {
        properties: {},
        rawSapData: {
          ItemWarehouseInfoCollection: [],
          selectedPrice: { Price: 1 },
          _resolvedDiscount: resolvedDiscount,
          _discountHsProperty: discountHsProperty,
        },
      };
    }

    it('blanks discount when syncing hs_discount_percentage', async () => {
      const item = buildItem('hs_discount_percentage', 10);

      await preprocess({ item, tenantModels: {}, preprocessContext });

      expect(item.properties).toEqual({ hs_discount_percentage: 10, discount: '' });
    });

    it('blanks hs_discount_percentage when syncing discount', async () => {
      const item = buildItem('discount', 10);

      await preprocess({ item, tenantModels: {}, preprocessContext });

      expect(item.properties).toEqual({ discount: 10, hs_discount_percentage: '' });
    });

    it('writes no discount property when the tenant has discounts disabled', async () => {
      // enrichRecordsWithDiscounts leaves both flags unset when isRequired is false.
      const item = buildItem(undefined, undefined);

      await preprocess({ item, tenantModels: {}, preprocessContext });

      expect(item.properties).toEqual({});
    });

    it('writes nothing when no discount group matched the product', async () => {
      const item = buildItem('hs_discount_percentage', null);

      await preprocess({ item, tenantModels: {}, preprocessContext });

      expect(item.properties).toEqual({});
    });
  });

  describe('_resolvedProductPrice puesto por OneToOneProductStrategy', () => {
    function buildTenantModels(priceFields) {
      return {
        Configuration: {
          findOneAndUpdate: jest.fn().mockResolvedValue({
            key: 'fieldsPricesHS',
            value: priceFields,
            userUpdated: 'admin',
          }),
        },
      };
    }

    it('escribe el precio resuelto en el campo de precio en vez de 0', async () => {
      const item = {
        properties: {},
        rawSapData: { _warehouseStock: {}, _resolvedProductPrice: 36.607143 },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties.hs_price_gtq).toBe(36.607143);
    });

    it('escribe el mismo precio en todos los campos de fieldsPricesHS', async () => {
      const item = {
        properties: {},
        rawSapData: { _warehouseStock: {}, _resolvedProductPrice: 36.607143 },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq', 'hs_price_usd']) });

      expect(item.properties.hs_price_gtq).toBe(36.607143);
      expect(item.properties.hs_price_usd).toBe(36.607143);
    });

    it('gana sobre selectedPrice: la guarda de selectedPrice no puede cortar antes', async () => {
      const item = {
        properties: {},
        rawSapData: {
          _warehouseStock: {},
          _resolvedProductPrice: 36.607143,
          selectedPrice: { PriceList: 1, Price: 36.607143 },
        },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties.hs_price_gtq).toBe(36.607143);
    });

    it('sigue cerando cuando la llave no esta (regresion del comportamiento actual)', async () => {
      const item = { properties: {}, rawSapData: { _warehouseStock: {} } };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties.hs_price_gtq).toBe(0);
    });

    it('cera cuando la llave viene en null o NaN, que es la ruta SET_ZERO', async () => {
      const withNull = { properties: {}, rawSapData: { _warehouseStock: {}, _resolvedProductPrice: null } };
      const withNaN = { properties: {}, rawSapData: { _warehouseStock: {}, _resolvedProductPrice: Number.NaN } };

      await preprocess({ item: withNull, tenantModels: buildTenantModels(['hs_price_gtq']) });
      await preprocess({ item: withNaN, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(withNull.properties.hs_price_gtq).toBe(0);
      expect(withNaN.properties.hs_price_gtq).toBe(0);
    });

    it('no interfiere con el stock por bodega ni con los lotes', async () => {
      const item = {
        properties: {},
        rawSapData: {
          _resolvedProductPrice: 36.607143,
          _warehouseStock: { gt00_onhand: 12 },
          [BATCH_EXPIRY_KEY]: { lotes_vigentes: 3 },
        },
      };

      await preprocess({ item, tenantModels: buildTenantModels(['hs_price_gtq']) });

      expect(item.properties).toEqual({
        gt00_onhand: 12,
        lotes_vigentes: 3,
        hs_price_gtq: 36.607143,
      });
    });
  });
});

describe('product.handler + lotes de caducidad', () => {
  it('copia las propiedades de lote cuando el enricher dejo la clave', async () => {
    const item = {
      rawSapData: {
        Product: '10000289',
        [WAREHOUSE_STOCK_KEY]: { dpdo_0001_stock: 8600 },
        [BATCH_EXPIRY_KEY]: { lotes_detalle: '17141 · vence 2026-11-01 · 9,654.000 · DPDO/0001', dias_para_vencer: 80 },
      },
      properties: {},
    };

    await preprocess({ item, tenantModels: {}, preprocessContext: { warehouseFields: [], priceFields: ['hs_price_usd'] } });

    expect(item.properties.lotes_detalle).toContain('17141');
    expect(item.properties.dias_para_vencer).toBe(80);
    // El stock por bodega no se pisa
    expect(item.properties.dpdo_0001_stock).toBe(8600);
  });

  it('sin la clave no escribe ninguna propiedad de lote', async () => {
    const item = { rawSapData: { Product: '10000289', [WAREHOUSE_STOCK_KEY]: {} }, properties: {} };

    await preprocess({ item, tenantModels: {}, preprocessContext: { warehouseFields: [], priceFields: ['hs_price_usd'] } });

    expect(item.properties).not.toHaveProperty('lotes_detalle');
    expect(item.properties).not.toHaveProperty('dias_para_vencer');
  });

  it('con la clave vacia escribe las propiedades vacias (limpia valores viejos)', async () => {
    const item = {
      rawSapData: { Product: 'X', [WAREHOUSE_STOCK_KEY]: {}, [BATCH_EXPIRY_KEY]: { lotes_detalle: '', cantidad_vencida: '' } },
      properties: {},
    };

    await preprocess({ item, tenantModels: {}, preprocessContext: { warehouseFields: [], priceFields: ['hs_price_usd'] } });

    expect(item.properties.lotes_detalle).toBe('');
    expect(item.properties.cantidad_vencida).toBe('');
  });
});
