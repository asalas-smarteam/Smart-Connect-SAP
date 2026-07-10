import { jest } from '@jest/globals';
import { SyncDealLineItemPricesByPriceList } from '../../../src/application/use-cases/SyncDealLineItemPricesByPriceList.js';

const ITEM_PRICES = [
  {
    PriceList: 2,
    Price: 0.0,
    Currency: 'QTZ',
    AdditionalPrice1: 49.96,
    AdditionalCurrency1: 'USD',
  },
  {
    PriceList: 4,
    Price: 1011.84,
    Currency: 'QTZ',
    AdditionalPrice1: 126.48,
    AdditionalCurrency1: 'USD',
  },
  {
    PriceList: 6,
    Price: 1241.2,
    Currency: 'QTZ',
    AdditionalPrice1: 155.15,
    AdditionalCurrency1: 'USD',
  },
];

const STRATEGY_CONFIG = {
  strategy: 'dealPriceList_LineItemPrice',
  dealPriceListProperty: 'lista_de_precios',
  lineItemPriceListProperty: 'lista_de_precios',
  dealCurrencyProperty: 'deal_currency_code',
  safePriceProperty: 'safe_price_value',
  currencyCodes: { GTQ: 'QTZ', USD: 'USD' },
};

function buildDeps({
  dealProperties = { lista_de_precios: '6', deal_currency_code: 'USD' },
  lineItems = { 'line-1': { hs_sku: 'A0001', quantity: '2' } },
  itemPricesBySku = { A0001: ITEM_PRICES },
  defaultPriceList = 4,
} = {}) {
  const credentialRepository = {
    resolveHubspotCredentials: jest.fn().mockResolvedValue({ clientConfigId: 'cfg-1' }),
    resolveSapCredentials: jest.fn().mockResolvedValue({
      serviceLayerBaseUrl: 'https://sap.example.com:50000',
    }),
    resolveTenantPriceList: jest.fn().mockResolvedValue(defaultPriceList),
    resolveTenantTaxSettings: jest.fn().mockResolvedValue({ fieldItem: null, taxCodes: [] }),
    resolveWarehouseStockProperties: jest.fn().mockResolvedValue({ A01_stock: 8 }),
  };
  const sapPriceClient = {
    fetchItemPrices: jest.fn().mockImplementation(async ({ itemCode }) => ({
      ItemPrices: itemPricesBySku[itemCode] || [],
      ItemWarehouseInfoCollection: [],
    })),
  };
  const hubspotPriceClient = {
    getAccessToken: jest.fn().mockResolvedValue('token-1'),
    fetchObject: jest.fn().mockImplementation(async ({ objectType, objectId }) => {
      if (objectType === 'deals') {
        return {
          id: objectId,
          properties: dealProperties,
          associations: {
            line_items: {
              results: Object.keys(lineItems).map((id) => ({ id })),
            },
          },
        };
      }

      return { id: objectId, properties: lineItems[objectId] };
    }),
    updateLineItems: jest.fn().mockImplementation(async ({ enrichedLineItems }) => ({
      payload: { inputs: enrichedLineItems.map((item) => ({ id: item.id })) },
      response: { results: enrichedLineItems.map((item) => ({ id: item.id })) },
    })),
    updateProducts: jest.fn().mockResolvedValue({
      payload: { inputs: [] },
      response: { results: [] },
    }),
    updateDealAmount: jest.fn().mockResolvedValue({
      payload: {},
      response: {},
    }),
  };

  return {
    credentialRepository,
    sapPriceClient,
    hubspotPriceClient,
    buildErrorResponseSnapshot: jest.fn().mockReturnValue({ message: 'snapshot' }),
    buildWebhookSyncErrorEntry: jest.fn().mockReturnValue({ entry: true }),
    logger: { warn: jest.fn() },
  };
}

const context = {
  tenantModels: { Configuration: {} },
  tenant: {},
  tenantKey: 'tenant_1',
};

describe('SyncDealLineItemPricesByPriceList', () => {
  it('prices line items with the deal price list and the deal currency (USD from AdditionalPrice1)', async () => {
    const deps = buildDeps();
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    const result = await useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context);

    expect(result.data.lineItems).toHaveLength(1);
    expect(result.data.lineItems[0]).toMatchObject({
      id: 'line-1',
      itemCode: 'A0001',
      Price: 155.15,
      lineTotal: 310.3,
      priceList: 6,
      omitDiscount: true,
      additionalProperties: {
        safe_price_value: '155.15',
        lista_de_precios: '6',
      },
    });
    expect(deps.hubspotPriceClient.updateDealAmount).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: 'deal-1', totalAmount: 310.3 })
    );
    expect(deps.credentialRepository.resolveTenantPriceList).toHaveBeenCalledWith({
      tenantModels: context.tenantModels,
      currency: 'USD',
    });
  });

  it('maps the deal currency to the SAP currency code (GTQ -> QTZ uses base Price)', async () => {
    const deps = buildDeps({
      dealProperties: { lista_de_precios: '6', deal_currency_code: 'GTQ' },
    });
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    const result = await useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context);

    expect(result.data.lineItems[0].Price).toBe(1241.2);
  });

  it('prefers the line item price list over the deal price list', async () => {
    const deps = buildDeps({
      lineItems: {
        'line-1': { hs_sku: 'A0001', quantity: '1', lista_de_precios: '4' },
      },
    });
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    const result = await useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context);

    expect(result.data.lineItems[0]).toMatchObject({
      Price: 126.48,
      priceList: 4,
    });
  });

  it('falls back to the default price list when the requested list has no price in the deal currency', async () => {
    // Lista 2 en QTZ tiene Price 0.0 -> sin precio; cae a la lista default (4).
    const deps = buildDeps({
      dealProperties: { lista_de_precios: '2', deal_currency_code: 'GTQ' },
    });
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    const result = await useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context);

    expect(result.data.lineItems[0]).toMatchObject({
      Price: 1011.84,
      priceList: 4,
    });
    expect(result.data.lineItems[0].additionalProperties.lista_de_precios).toBe('4');
  });

  it('skips lines without a resolvable price and reports them, failing only if none resolve', async () => {
    const deps = buildDeps({
      lineItems: {
        'line-1': { hs_sku: 'A0001', quantity: '1' },
        'line-2': { hs_sku: 'B0002', quantity: '1' },
      },
      itemPricesBySku: {
        A0001: ITEM_PRICES,
        B0002: [],
      },
    });
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    const result = await useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context);

    expect(result.data.lineItems).toHaveLength(1);
    expect(result.data.skippedLineItems).toEqual([{ id: 'line-2', itemCode: 'B0002' }]);
    expect(result.meta.skippedCount).toBe(1);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('throws when no line item price can be resolved', async () => {
    const deps = buildDeps({ itemPricesBySku: { A0001: [] } });
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    await expect(
      useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context)
    ).rejects.toThrow('No line item prices could be resolved');
  });

  it('never writes the discount property (omitDiscount on every line)', async () => {
    const deps = buildDeps();
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    await useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context);

    const { enrichedLineItems } = deps.hubspotPriceClient.updateLineItems.mock.calls[0][0];
    expect(enrichedLineItems.every((item) => item.omitDiscount === true)).toBe(true);
  });

  it('throws when the deal has no currency property', async () => {
    const deps = buildDeps({ dealProperties: { lista_de_precios: '6' } });
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    await expect(
      useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context)
    ).rejects.toThrow('deal_currency_code is required');
  });

  it('throws when the strategy config is incomplete', async () => {
    const deps = buildDeps();
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    await expect(
      useCase.execute(
        { dealId: 'deal-1', strategyConfig: { ...STRATEGY_CONFIG, dealPriceListProperty: null } },
        context
      )
    ).rejects.toThrow('lineItemPriceStrategy configuration is missing dealPriceListProperty');
  });

  it('attaches sync log error entries on failure', async () => {
    const deps = buildDeps({ itemPricesBySku: { A0001: [] } });
    const useCase = new SyncDealLineItemPricesByPriceList(deps);

    try {
      await useCase.execute({ dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG }, context);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error.syncLogWebhookErrors).toHaveLength(1);
      expect(deps.buildWebhookSyncErrorEntry).toHaveBeenCalled();
    }
  });
});
