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

  return {
    useCase,
    credentialRepository,
    sapPriceClient,
    hubspotPriceClient,
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
        dealUpdated: true,
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
});
