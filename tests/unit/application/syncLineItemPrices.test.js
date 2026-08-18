import { jest } from '@jest/globals';
import SyncLineItemPrices from '../../../src/application/use-cases/SyncLineItemPrices.js';
// Se inyecta el constructor REAL del audit, no un doble: lo que hay que verificar es que el
// audit que sale de `execute` sea legible, y un doble identidad taparía cualquier pérdida en
// la serialización.
import { buildLineItemPriceAudit } from '../../../src/infrastructure/sync/syncLog.service.js';

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
    buildLineItemPriceAudit,
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
          aborted: false,
          failures: [],
        },
      },
      // `capturedAt` es un timestamp, así que el audit va con objectContaining; todo lo demás
      // del audit sí se fija con valores concretos.
      audit: expect.objectContaining({
        dealId: 'deal-1',
        cardCode: 'C20000',
        rounds: [
          {
            round: 1,
            lineItemIdsInPayload: ['line-1'],
            priced: [{ id: 'line-1', itemCode: 'A0001', price: 704.35, source: 'sap' }],
            failures: [],
          },
        ],
        calls: [],
        droppedCalls: 0,
        unresolved: [],
        amount: { written: true, total: 1408.7 },
        fatalError: null,
      }),
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

  it('still writes the deal amount when the reconciliation re-read fails', async () => {
    const logger = { warn: jest.fn() };
    const { useCase, hubspotPriceClient } = createUseCase({ logger });

    hubspotPriceClient.readDealLineItemIds.mockRejectedValue(new Error('HubSpot deal read failed'));

    // Que `execute` resuelva en vez de rechazar es parte de lo que se prueba: llegar a las
    // aserciones con un `result` ya demuestra que la pasada de seguridad no tumbó la corrida.
    const result = await useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    // La ronda 1 ya había escrito los precios: su total no se pierde por una relectura caída.
    expect(hubspotPriceClient.updateDealAmount).toHaveBeenCalledTimes(1);
    expect(hubspotPriceClient.updateDealAmount.mock.calls[0][0].totalAmount).toBe(1408.7);
    expect(result.meta.dealUpdated).toBe(true);
    expect(result.meta.reconciliation).toEqual({
      triggered: false,
      trigger: [],
      pricedCount: 0,
      aborted: true,
      failures: [
        {
          stage: 'reconciliation',
          reason: 'HubSpot deal read failed',
          status: null,
          endpoint: null,
        },
      ],
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey: 'tenant_1',
      dealId: 'deal-1',
      error: 'HubSpot deal read failed',
    }));
  });

  // La ronda 2 reescribe líneas que la ronda 1 ya había escrito bien (la rama `zero_price`
  // existe justo para eso), así que tiene que enriquecer EXACTAMENTE igual que la ronda 1. Si
  // no pide la propiedad de misc a HubSpot, el uplift sale null y el precio crudo de SAP pisa
  // el precio correcto: una pasada de SEGURIDAD escribiendo un campo de dinero equivocado.
  it('applies the misc uplift when the reconciliation rewrites a line', async () => {
    const {
      useCase,
      credentialRepository,
      hubspotPriceClient,
      sapPriceClient,
    } = createUseCase();

    credentialRepository.resolveMiscPriceCalculationConfig = jest.fn().mockResolvedValue({
      enableMiscPriceCalculation: true,
      originalPriceTargetProperty: 'safe_price_value',
      miscSourceProperty: 'misc',
      miscCalculationType: 'porcentual',
    });
    sapPriceClient.fetchBusinessPartnerPrice.mockResolvedValue({
      Price: 100,
      Currency: 'USD',
      Discount: 0,
    });
    // La relectura ve price 0 (la escritura de la ronda 1 todavía no se refleja), y la caché de
    // SAP la contradice: se dispara `zero_price` sobre una línea YA valorizada en 115.
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [{
        id: 'line-1',
        itemCode: 'A0001',
        quantity: '2',
        price: '0',
        misc: '15',
        properties: { misc: '15' },
      }],
      failures: [],
    });

    await useCase.execute(
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

    // Sin la propiedad de misc en la relectura, `calculateUnitPriceWithMisc` no tiene de dónde
    // leer el porcentaje y devuelve el precio crudo.
    expect(hubspotPriceClient.readLineItems).toHaveBeenCalledWith({
      token: 'hubspot-token',
      lineItemIds: ['line-1'],
      extraProperties: ['misc', 'price'],
    });
    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(2);
    // La ronda 2 escribe el precio CON uplift (115), y `safe_price_value` sigue llevando la base
    // de SAP (100) y no el precio final: es la base de la que parte el recálculo de misc.
    expect(hubspotPriceClient.updateLineItems.mock.calls[1][0].enrichedLineItems).toEqual([
      {
        itemCode: 'A0001',
        id: 'line-1',
        quantity: 2,
        Price: 115,
        originalPrice: 100,
        originalPriceTargetProperty: 'safe_price_value',
        Currency: 'USD',
        Discount: 0,
        lineTotal: 230,
        warehouseStockProperties: { A01_stock: 8 },
      },
    ]);
  });

  it('keeps the resolved SAP discount when the reconciliation rewrites a line', async () => {
    const sapDiscountClient = {
      fetchActiveDiscountGroups: jest.fn().mockResolvedValue([
        {
          ValidFrom: '2026-01-01T00:00:00Z',
          ValidTo: '2026-12-31T00:00:00Z',
          DiscountGroupLineCollection: [
            { ObjectType: 'dgboItems', ObjectCode: 'A0001', Discount: 12 },
          ],
        },
      ]),
    };
    const { useCase, credentialRepository, hubspotPriceClient } = createUseCase({
      sapDiscountClient,
    });

    credentialRepository.resolveDiscountConfig = jest.fn().mockResolvedValue({
      isRequired: true,
      fieldMappings: { Discount: 'hs_discount_percentage' },
    });
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [{ id: 'line-1', itemCode: 'A0001', quantity: '2', price: '0', properties: {} }],
      failures: [],
    });

    await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 2 }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    expect(hubspotPriceClient.updateLineItems).toHaveBeenCalledTimes(2);
    // `_discountHsProperty` viaja igual en las dos rondas, así que un `Discount: 0` acá escribe
    // "0" en HubSpot encima del 12 que la ronda 1 resolvió contra los grupos de descuento.
    expect(hubspotPriceClient.updateLineItems.mock.calls[1][0].enrichedLineItems).toEqual([
      {
        itemCode: 'A0001',
        id: 'line-1',
        quantity: 2,
        Price: 704.35,
        Currency: 'C$',
        Discount: 12,
        lineTotal: 1408.7,
        _discountHsProperty: 'hs_discount_percentage',
        warehouseStockProperties: { A01_stock: 8 },
      },
    ]);
  });

  it('returns an audit with the failed line and its stage', async () => {
    const { useCase, sapPriceClient } = createUseCase();

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
        ],
        lineItemFailures: [{
          id: 'line-3', stage: 'hubspot_read', reason: '404 Not Found', status: 404,
          endpoint: '/crm/v3/objects/line_items/line-3',
        }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    const failures = result.audit.rounds[0].failures;
    expect(failures.map((entry) => entry.stage).sort()).toEqual(['hubspot_read', 'sap_price']);
    expect(result.audit.dealId).toBe('deal-1');
    expect(result.audit.amount.written).toBe(true);
  });

  it('keeps the three failure shapes intact in the audit', async () => {
    const { useCase, sapPriceClient, hubspotPriceClient } = createUseCase();

    sapPriceClient.fetchBusinessPartnerPrice = jest.fn(async ({ itemCode }) => {
      if (itemCode === 'BAD') {
        throw new Error('Price list 4 not found for item BAD');
      }
      return { Price: 100, Currency: 'C$', Discount: 0 };
    });
    hubspotPriceClient.readDealLineItemIds.mockRejectedValue(new Error('HubSpot deal read failed'));

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'BAD', id: 'line-2', quantity: 1 },
        ],
        lineItemFailures: [{
          id: 'line-3', stage: 'hubspot_read', reason: '404 Not Found', status: 404,
          endpoint: '/crm/v3/objects/line_items/line-3',
        }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    // Los tres shapes conviven sin normalizarse: `hubspot_read` trae endpoint y no itemCode,
    // `sap_price` trae itemCode y no endpoint, y `reconciliation` no trae ni id ni itemCode.
    expect(result.audit.unresolved).toEqual([
      {
        id: 'line-3',
        stage: 'hubspot_read',
        reason: '404 Not Found',
        status: 404,
        endpoint: '/crm/v3/objects/line_items/line-3',
      },
      {
        id: 'line-2',
        itemCode: 'BAD',
        stage: 'sap_price',
        reason: 'Price list 4 not found for item BAD',
        status: null,
      },
      {
        stage: 'reconciliation',
        reason: 'HubSpot deal read failed',
        status: null,
        endpoint: null,
      },
    ]);
  });

  it('attaches the audit to the thrown error when the whole deal fails', async () => {
    const failing = createUseCase({
      sapPriceClient: {
        fetchBusinessPartnerPrice: jest.fn().mockRejectedValue(new Error('SAP down')),
        fetchItemPrices: jest.fn().mockRejectedValue(new Error('SAP down')),
      },
    });

    await expect(failing.useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1' }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    )).rejects.toMatchObject({
      lineItemPriceAudit: expect.objectContaining({
        rounds: expect.any(Array),
      }),
    });
  });

  it('carries the round 1 failures and the fatal error in the audit of a total failure', async () => {
    const failing = createUseCase({
      sapPriceClient: {
        fetchBusinessPartnerPrice: jest.fn().mockRejectedValue(
          Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
            details: { status: 404, endpoint: '/b1s/v2/CompanyService_GetItemPrice' },
          })
        ),
        fetchItemPrices: jest.fn().mockRejectedValue(new Error('SAP down')),
      },
    });

    const error = await failing.useCase.execute(
      { dealId: 'deal-1', cardCode: 'C20000', lineItems: [{ itemCode: 'A0001', id: 'line-1' }] },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    ).then(() => null, (thrown) => thrown);

    expect(error.message).toBe('No line item prices could be resolved for this deal');
    // La ronda 1 se empuja al audit ANTES del fatal: sin esto el audit de una corrida que no
    // valorizó nada no diría por qué falló ninguna línea, que es el caso que reportó el cliente.
    expect(error.lineItemPriceAudit.rounds).toEqual([
      {
        round: 1,
        lineItemIdsInPayload: ['line-1'],
        priced: [],
        failures: [{
          id: 'line-1',
          itemCode: 'A0001',
          stage: 'sap_price',
          reason: 'HubSpot API request failed: 404 Not Found',
          status: 404,
        }],
      },
    ]);
    expect(error.lineItemPriceAudit.fatalError).toEqual({
      message: 'No line item prices could be resolved for this deal',
      status: null,
      endpoint: null,
    });
    expect(error.lineItemPriceAudit.dealId).toBe('deal-1');
    expect(error.lineItemPriceAudit.cardCode).toBe('C20000');
  });

  it('keeps the payload hubspot_read failures in the audit when the run throws before round 1', async () => {
    const { useCase, credentialRepository } = createUseCase();

    // Falla antes del ciclo de la ronda 1: no hay `rounds`, así que `unresolved` es el ÚNICO
    // lugar donde puede quedar la evidencia del 404 por línea que trajo el payload.
    credentialRepository.resolveHubspotCredentials.mockRejectedValue(
      new Error('HubSpot credentials are not configured')
    );

    const error = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: 'line-1', quantity: 1 }],
        lineItemFailures: [{
          id: 'line-3', stage: 'hubspot_read', reason: '404 Not Found', status: 404,
          endpoint: '/crm/v3/objects/line_items/line-3',
        }],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    ).then(() => null, (thrown) => thrown);

    expect(error.message).toBe('HubSpot credentials are not configured');
    expect(error.lineItemPriceAudit.rounds).toEqual([]);
    expect(error.lineItemPriceAudit.unresolved).toEqual([{
      id: 'line-3',
      stage: 'hubspot_read',
      reason: '404 Not Found',
      status: 404,
      endpoint: '/crm/v3/objects/line_items/line-3',
    }]);
  });

  it('drops a line from unresolved when round 2 priced it successfully', async () => {
    const { useCase, sapPriceClient, hubspotPriceClient } = createUseCase();

    let badAttempts = 0;
    sapPriceClient.fetchBusinessPartnerPrice = jest.fn(async ({ itemCode }) => {
      if (itemCode === 'BAD') {
        badAttempts += 1;
        if (badAttempts === 1) {
          throw new Error('Price list 4 not found for item BAD');
        }
      }
      return { Price: 100, Currency: 'C$', Discount: 0 };
    });
    // La ronda 1 sólo escribió line-1, así que el conteo no cuadra y la reconciliación corre.
    hubspotPriceClient.readDealLineItemIds.mockResolvedValue(['line-1', 'line-2']);
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [
        { id: 'line-1', itemCode: 'A0001', quantity: '1', price: '100', properties: {} },
        { id: 'line-2', itemCode: 'BAD', quantity: '1', price: '0', properties: {} },
      ],
      failures: [],
    });

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'BAD', id: 'line-2', quantity: 1 },
        ],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    // El reintento de la ronda 2 sí volvió a SAP (los fallos no se memorizan) y salió bien.
    expect(badAttempts).toBe(2);
    expect(result.audit.rounds[1].priced).toEqual([
      { id: 'line-2', itemCode: 'BAD', price: 100, source: 'sap' },
    ]);
    // La línea quedó escrita, así que no puede figurar como no resuelta...
    expect(result.audit.unresolved).toEqual([]);
    // ...pero la evidencia del fallo de la ronda 1 no se pierde, sigue en su ronda.
    expect(result.audit.rounds[0].failures).toEqual([{
      id: 'line-2',
      itemCode: 'BAD',
      stage: 'sap_price',
      reason: 'Price list 4 not found for item BAD',
      status: null,
    }]);
  });

  it('lists a line that failed in both rounds exactly once in unresolved', async () => {
    const { useCase, sapPriceClient, hubspotPriceClient } = createUseCase();

    sapPriceClient.fetchBusinessPartnerPrice = jest.fn(async ({ itemCode }) => {
      if (itemCode === 'BAD') {
        throw new Error('Price list 4 not found for item BAD');
      }
      return { Price: 100, Currency: 'C$', Discount: 0 };
    });
    hubspotPriceClient.readDealLineItemIds.mockResolvedValue(['line-1', 'line-2']);
    hubspotPriceClient.readLineItems.mockResolvedValue({
      lineItems: [
        { id: 'line-1', itemCode: 'A0001', quantity: '1', price: '100', properties: {} },
        { id: 'line-2', itemCode: 'BAD', quantity: '1', price: '0', properties: {} },
      ],
      failures: [],
    });

    const result = await useCase.execute(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: 'line-1', quantity: 1 },
          { itemCode: 'BAD', id: 'line-2', quantity: 1 },
        ],
      },
      {
        tenantModels: { HubspotCredentials: {}, SapCredentials: {}, Configuration: {} },
        tenant: {},
        tenantKey: 'tenant_1',
      }
    );

    // Falló en las dos rondas, así que está en las dos listas de fallos...
    expect(result.audit.rounds[0].failures).toHaveLength(1);
    expect(result.audit.rounds[1].failures).toHaveLength(1);
    // ...pero `unresolved` la nombra una sola vez.
    expect(result.audit.unresolved).toEqual([{
      id: 'line-2',
      itemCode: 'BAD',
      stage: 'sap_price',
      reason: 'Price list 4 not found for item BAD',
      status: null,
    }]);
  });
});
