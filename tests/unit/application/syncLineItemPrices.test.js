import { jest } from '@jest/globals';
import SyncLineItemPrices from '../../../src/application/use-cases/SyncLineItemPrices.js';

function createUseCase(overrides = {}) {
  const credentialRepository = {
    resolveHubspotCredentials: jest.fn().mockResolvedValue({
      clientConfigId: 'client-config-1',
      portalId: '12345',
    }),
    resolveSapCredentials: jest.fn().mockResolvedValue({
      serviceLayerBaseUrl: 'https://sap.example.com:50000',
    }),
    resolveTenantPriceList: jest.fn().mockResolvedValue(4),
    resolveTenantTaxSettings: jest.fn().mockResolvedValue({
      fieldItem: null,
      taxCodes: [],
    }),
    resolveWarehouseStockProperties: jest.fn().mockResolvedValue({
      A01_stock: 8,
    }),
  };
  const sapPriceClient = {
    fetchBusinessPartnerPrice: jest.fn().mockResolvedValue({
      Price: 704.35,
      Currency: 'C$',
      Discount: 0,
    }),
    fetchItemPrices: jest.fn().mockResolvedValue({
      ItemPrices: [{ PriceList: 4, Price: 704.35, Currency: 'C$' }],
      ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', Ordered: 2, Committed: 1, InStock: 7 }],
    }),
  };
  const hubspotPriceClient = {
    getAccessToken: jest.fn().mockResolvedValue('hubspot-token'),
    updateLineItems: jest.fn().mockResolvedValue({
      payload: { inputs: [{ id: 'line-1' }] },
      response: { results: [{ id: 'line-1' }] },
    }),
    updateProducts: jest.fn().mockResolvedValue({
      payload: { inputs: [{ id: 'product-1' }] },
      response: { results: [{ id: 'product-1' }] },
    }),
    updateDealAmount: jest.fn().mockResolvedValue({
      payload: { properties: { amount: '1408.7' } },
      response: { id: 'deal-1' },
    }),
    readDealLineItemIds: jest.fn().mockResolvedValue(['line-1']),
    readLineItems: jest.fn().mockResolvedValue({
      lineItems: [{ id: 'line-1', itemCode: 'A0001', quantity: '2', price: '704.35', properties: {} }],
      failures: [],
    }),
  };
  const buildErrorResponseSnapshot = jest.fn((error) => ({ message: error.message }));
  const buildWebhookSyncErrorEntry = jest.fn((entry) => entry);

  const useCase = new SyncLineItemPrices({
    credentialRepository,
    sapPriceClient,
    hubspotPriceClient,
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
    dateProvider: () => new Date('2026-04-08T12:00:00.000Z'),
    ...overrides,
  });

  // Se devuelven los dobles que realmente recibió el caso de uso: si el test los sobreescribe,
  // asertar sobre los de por defecto (que nadie llamó) daría un falso verde.
  return {
    useCase,
    credentialRepository,
    sapPriceClient: overrides.sapPriceClient ?? sapPriceClient,
    hubspotPriceClient: overrides.hubspotPriceClient ?? hubspotPriceClient,
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
  };
}

describe('SyncLineItemPrices', () => {
  it('syncs business partner prices through injected ports', async () => {
    const {
      useCase,
      credentialRepository,
      sapPriceClient,
      hubspotPriceClient,
    } = createUseCase();

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: { client: { hubspot: { portalId: '12345' } } },
        tenantKey: 'tenant_1',
      }
    );

    expect(credentialRepository.resolveHubspotCredentials).toHaveBeenCalledWith({
      tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
      tenant: { client: { hubspot: { portalId: '12345' } } },
    });
    expect(credentialRepository.resolveTenantPriceList).not.toHaveBeenCalled();
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledWith({
      sapConfig: {
        serviceLayerBaseUrl: 'https://sap.example.com:50000',
        tenantKey: 'tenant_1',
      },
      cardCode: 'C20000',
      itemCode: 'A0001',
      date: '2026-04-08',
      tenantKey: 'tenant_1',
      requestPayload: {
        ItemPriceParams: {
          ItemCode: 'A0001',
          CardCode: 'C20000',
          Date: '2026-04-08',
        },
      },
    });
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledWith({
      token: 'hubspot-token',
      enrichedLineItems: [
        {
          itemCode: 'A0001',
          id: 'line-1',
          quantity: 2,
          Price: 704.35,
          Currency: 'C$',
          Discount: 0,
          lineTotal: 1408.7,
          warehouseStockProperties: { A01_stock: 8 },
        },
      ],
      tenantKey: 'tenant_1',
    });
    expect(result).toEqual({
      data: {
        cardCode: 'C20000',
        dealId: 'deal-1',
        totalAmount: 1408.7,
        lineItems: [
          {
            itemCode: 'A0001',
            id: 'line-1',
            quantity: 2,
            Price: 704.35,
            Currency: 'C$',
            Discount: 0,
            lineTotal: 1408.7,
            warehouseStockProperties: { A01_stock: 8 },
          },
        ],
      },
      meta: {
        requestedCount: 1,
        updatedCount: 1,
        productsRequestedCount: 1,
        productsUpdatedCount: 1,
        skippedCount: 0,
        dealUpdated: true,
        reconciliation: {
          triggered: false,
          trigger: [],
          pricedCount: 0,
        },
      },
    });
  });

  it('uses tenant price list when cardCode is absent', async () => {
    const { useCase, credentialRepository, sapPriceClient } = createUseCase();

    const result = await useCase.execute(
      {
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 0 }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(credentialRepository.resolveTenantPriceList).toHaveBeenCalledWith({
      tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
    });
    expect(sapPriceClient.fetchBusinessPartnerPrice).not.toHaveBeenCalled();
    expect(sapPriceClient.fetchItemPrices).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      cardCode: null,
      dealId: null,
      totalAmount: 704.35,
      lineItems: [
        {
          itemCode: 'A0001',
          quantity: 1,
          Price: 704.35,
          Currency: 'C$',
          Discount: 0,
          lineTotal: 704.35,
        },
      ],
    });
  });

  it('uses configured SAP tax field as HubSpot line item discount for business partner prices', async () => {
    const { useCase, credentialRepository, sapPriceClient, hubspotPriceClient } = createUseCase();

    credentialRepository.resolveTenantTaxSettings.mockResolvedValue({
      fieldItem: 'U_SalesTaxCode',
      taxCodes: [
        { Code: 'IVA', Rate: 15 },
        { Code: 'EXE', Rate: 0 },
      ],
    });
    sapPriceClient.fetchItemPrices.mockResolvedValue({
      U_SalesTaxCode: 'IVA',
      ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', Ordered: 2, Committed: 1, InStock: 7 }],
    });

    await useCase.execute(
      {
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(sapPriceClient.fetchItemPrices).toHaveBeenCalledWith({
      sapConfig: {
        serviceLayerBaseUrl: 'https://sap.example.com:50000',
        tenantKey: 'tenant_1',
      },
      itemCode: 'A0001',
      tenantKey: 'tenant_1',
      selectFields: ['ItemPrices', 'ItemWarehouseInfoCollection', 'U_SalesTaxCode'],
    });
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledWith({
      token: 'hubspot-token',
      enrichedLineItems: [
        expect.objectContaining({
          id: 'line-1',
          Price: 704.35,
          Discount: 15,
        }),
      ],
      tenantKey: 'tenant_1',
    });
  });

  it('uses configured SAP tax field as HubSpot line item discount with tenant price list', async () => {
    const { useCase, credentialRepository, sapPriceClient } = createUseCase();

    credentialRepository.resolveTenantTaxSettings.mockResolvedValue({
      fieldItem: 'U_SalesTaxCode',
      taxCodes: [
        { Code: 'IVA', Rate: 15 },
        { Code: 'EXE', Rate: 0 },
      ],
    });
    sapPriceClient.fetchItemPrices.mockResolvedValue({
      U_SalesTaxCode: 'IVA',
      ItemPrices: [{ PriceList: 4, Price: 704.35, Currency: 'C$' }],
      ItemWarehouseInfoCollection: [{ WarehouseCode: 'A01', Ordered: 2, Committed: 1, InStock: 7 }],
    });

    const result = await useCase.execute(
      {
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 1 }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.data.lineItems).toEqual([
      expect.objectContaining({
        itemCode: 'A0001',
        Price: 704.35,
        Discount: 15,
      }),
    ]);
  });

  it('stores SAP price in configured property and updates price with percentage miscellaneous', async () => {
    const { useCase, credentialRepository, sapPriceClient, hubspotPriceClient } = createUseCase();

    credentialRepository.resolveMiscPriceCalculationConfig = jest.fn().mockResolvedValue({
      enableMiscPriceCalculation: true,
      originalPriceTargetProperty: 'safe_amount',
      miscSourceProperty: 'misc',
      miscCalculationType: 'porcentual',
    });
    sapPriceClient.fetchBusinessPartnerPrice.mockResolvedValue({
      Price: 100,
      Currency: 'USD',
      Discount: 0,
    });

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2, misc: '15' }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(credentialRepository.resolveMiscPriceCalculationConfig).toHaveBeenCalledWith({
      tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
    });
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledWith({
      token: 'hubspot-token',
      enrichedLineItems: [
        expect.objectContaining({
          id: 'line-1',
          Price: 115,
          originalPrice: 100,
          originalPriceTargetProperty: 'safe_amount',
          lineTotal: 230,
        }),
      ],
      tenantKey: 'tenant_1',
    });
    expect(result.data).toMatchObject({
      totalAmount: 230,
      lineItems: [
        expect.objectContaining({
          Price: 115,
          originalPrice: 100,
          originalPriceTargetProperty: 'safe_amount',
        }),
      ],
    });
  });

  it('attaches sync log details when an injected adapter fails', async () => {
    const hubspotError = new Error('HubSpot API request failed');
    const hubspotPriceClient = {
      getAccessToken: jest.fn().mockResolvedValue('hubspot-token'),
      updateLineItems: jest.fn().mockRejectedValue(hubspotError),
      updateProducts: jest.fn(),
      updateDealAmount: jest.fn(),
    };
    const {
      useCase,
      buildErrorResponseSnapshot,
      buildWebhookSyncErrorEntry,
    } = createUseCase({ hubspotPriceClient });

    await expect(
      useCase.execute(
        {
          cardCode: 'C20000',
          lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }],
        },
        {
          tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
          tenant: {},
          tenantKey: 'tenant_1',
        }
      )
    ).rejects.toMatchObject({
      syncLogWebhookErrors: [
        {
          payloadHubspot: {
            cardCode: 'C20000',
            lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }],
          },
          payloadSap: [
            {
              ItemPriceParams: {
                ItemCode: 'A0001',
                CardCode: 'C20000',
                Date: '2026-04-08',
              },
            },
          ],
          responseHubspot: {
            error: { message: 'HubSpot API request failed' },
          },
          responseSap: [{ Price: 704.35, Currency: 'C$', Discount: 0 }],
        },
      ],
    });
    expect(buildErrorResponseSnapshot).toHaveBeenCalledWith(hubspotError);
    expect(buildWebhookSyncErrorEntry).toHaveBeenCalled();
  });

  it('records SAP and HubSpot traffic through the injected recorder', async () => {
    const calls = [];
    const createSapCallRecorder = () => ({
      calls,
      droppedCalls: 0,
      record: async (options, run) => {
        try {
          const response = await run();
          calls.push({ ...options, ok: true });
          return response;
        } catch (error) {
          calls.push({ ...options, ok: false, error });
          throw error;
        }
      },
      wrap: (adapter) => adapter,
    });

    const { useCase } = createUseCase({ createSapCallRecorder });

    await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: { client: { hubspot: { portalId: '12345' } } },
        tenantKey: 'tenant_1',
      }
    );

    expect(calls.some((call) => call.target === 'sap' && call.ok === true)).toBe(true);
    expect(calls.some((call) => call.target === 'hubspot'
      && call.path === '/crm/v3/objects/line_items/batch/update')).toBe(true);
  });

  it('keeps pricing the other lines when SAP fails for one item', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    sapPriceClient.fetchBusinessPartnerPrice = jest.fn(async ({ itemCode }) => {
      if (itemCode === 'BAD') {
        throw new Error('Price list 4 not found for item BAD');
      }
      return { Price: 100, Currency: 'C$', Discount: 0 };
    });

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'BAD', id: 'line-2', quantity: 1 },
          { itemCode: 'A0002', id: 'line-3', quantity: 1 },
        ],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    const sent = hubspotPriceClient.updateLineItems.mock.calls[0][0].enrichedLineItems;
    expect(sent.map((line) => line.id)).toEqual(['line-1', 'line-3']);
    expect(result.meta.skippedCount).toBe(1);
  });

  it('queries SAP once for an itemCode repeated across two lines', async () => {
    const { useCase, sapPriceClient } = createUseCase();

    await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'A0001', id: 'line-2', quantity: 4 },
        ],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
  });

  it('throws when SAP fails for every line', async () => {
    const { useCase } = createUseCase({
      sapPriceClient: {
        fetchBusinessPartnerPrice: jest.fn().mockRejectedValue(new Error('SAP down')),
        fetchItemPrices: jest.fn().mockRejectedValue(new Error('SAP down')),
      },
    });

    await expect(useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1' }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    )).rejects.toThrow('No line item prices could be resolved for this deal');
  });

  it('works without a recorder injected (noop default)', async () => {
    const { useCase, hubspotPriceClient } = createUseCase();

    await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1' }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalled();
  });

  it('does not reconcile when count and prices already match', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.triggered).toBe(false);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(1);
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
  });

  it('reconciles a line that appeared after the first read, reusing the SAP cache', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    hubspotPriceClient.readDealLineItemIds.mockResolvedValue(['line-1', 'line-2']);
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [
        { id: 'line-1', itemCode: 'A0001', quantity: '2', price: '704.35', properties: {} },
        { id: 'line-2', itemCode: 'A0001', quantity: '1', price: '0', properties: {} },
      ],
      failures: [],
    });

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.triggered).toBe(true);
    expect(result.meta.reconciliation.trigger).toContain('count_mismatch');
    // A0001 ya estaba en caché: la ronda 2 no vuelve a SAP.
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(2);
    expect(hubspotPriceClient.updateLineItems.mock.calls[1][0].enrichedLineItems[0].id).toBe('line-2');
  });

  it('does not reconcile a zero price that SAP itself reports as zero', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase({
      sapPriceClient: {
        fetchBusinessPartnerPrice: jest.fn().mockResolvedValue({ Price: 0, Currency: 'C$', Discount: 0 }),
        fetchItemPrices: jest.fn().mockResolvedValue({
          ItemPrices: [{ PriceList: 4, Price: 0, Currency: 'C$' }],
          ItemWarehouseInfoCollection: [],
        }),
      },
    });

    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [{ id: 'line-1', itemCode: 'A0001', quantity: '2', price: '0', properties: {} }],
      failures: [],
    });

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.triggered).toBe(false);
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(1);
  });

  it('reconciles a zero price that the SAP cache contradicts, without calling SAP again', async () => {
    const { useCase, hubspotPriceClient, sapPriceClient } = createUseCase();

    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [{ id: 'line-1', itemCode: 'A0001', quantity: '2', price: '0', properties: {} }],
      failures: [],
    });

    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(result.meta.reconciliation.trigger).toContain('zero_price');
    expect(sapPriceClient.fetchBusinessPartnerPrice).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(2);
    // Reusar la caché tiene que producir una línea completa, no sólo ahorrarse la llamada a SAP.
    expect(hubspotPriceClient.updateLineItems.mock.calls[1][0].enrichedLineItems).toEqual([
      {
        itemCode: 'A0001',
        id: 'line-1',
        quantity: 2,
        Price: 704.35,
        Currency: 'C$',
        Discount: 0,
        lineTotal: 1408.7,
        warehouseStockProperties: { A01_stock: 8 },
      },
    ]);
  });

  it('updates the deal amount once, after reconciliation, with both rounds', async () => {
    const { useCase, hubspotPriceClient } = createUseCase();

    hubspotPriceClient.readDealLineItemIds.mockResolvedValue(['line-1', 'line-2']);
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [
        { id: 'line-1', itemCode: 'A0001', quantity: '1', price: '704.35', properties: {} },
        { id: 'line-2', itemCode: 'A0001', quantity: '1', price: '0', properties: {} },
      ],
      failures: [],
    });

    await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 1 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(hubspotPriceClient.updateDealAmount).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateDealAmount.mock.calls[0][0].totalAmount).toBe(1408.7);
  });
});
