import { jest } from '@jest/globals';

const mockHubspotGet = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  hubspotGet: mockHubspotGet,
  batchUpdateLineItems: jest.fn(),
}));

const { DealPriceListLineItemPriceWebhookService } = await import(
  '../../src/infrastructure/webhook/dealPriceListLineItemPriceWebhook.service.js'
);

const STRATEGY_CONFIG = {
  strategy: 'dealPriceList_LineItemPrice',
  dealPriceListProperty: 'lista_de_precios',
  lineItemPriceListProperty: 'lista_de_precios',
  dealCurrencyProperty: 'deal_currency_code',
  safePriceProperty: 'safe_price_value',
  currencyCodes: {},
};

function leanResult(value) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function buildTenantModels() {
  return {
    HubspotCredentials: {
      findOne: jest.fn().mockResolvedValue({ clientConfigId: 'cfg-1' }),
    },
    LineItemPriceWebhookEvent: {
      findOne: jest.fn().mockReturnValue(leanResult(null)),
      create: jest.fn().mockResolvedValue({ _id: 'event-1' }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    },
    Configuration: {},
  };
}

function buildService({ executeResult } = {}) {
  const syncDealLineItemPrices = {
    execute: jest.fn().mockResolvedValue(
      executeResult ?? {
        data: {},
        meta: { requestedCount: 2, updatedCount: 2, skippedCount: 0, dealUpdated: true },
      }
    ),
  };
  const hubspotAuth = { getAccessToken: jest.fn().mockResolvedValue('token-1') };
  const tenantConfiguration = {
    getValue: jest.fn().mockResolvedValue({ requireSkipped: true, secondsToSkipped: 3 }),
  };
  const service = new DealPriceListLineItemPriceWebhookService({
    syncDealLineItemPrices,
    hubspotAuth,
    tenantConfiguration,
    log: { warn: jest.fn(), error: jest.fn() },
  });

  return { service, syncDealLineItemPrices, hubspotAuth, tenantConfiguration };
}

function buildAssociationPayload(overrides = {}) {
  return {
    eventId: 100,
    subscriptionId: 200,
    portalId: 300,
    appId: 400,
    occurredAt: 1783002936606,
    associationType: 'DEAL_TO_LINE_ITEM',
    changeSource: 'USER',
    fromObjectId: 'deal-1',
    toObjectId: 'line-1',
    ...overrides,
  };
}

function buildDealPropertyChangePayload(overrides = {}) {
  return {
    eventId: 101,
    subscriptionId: 201,
    portalId: 300,
    appId: 400,
    occurredAt: 1783002936700,
    subscriptionType: 'deal.propertyChange',
    propertyName: 'lista_de_precios',
    propertyValue: '6',
    changeSource: 'CRM_UI',
    objectId: 'deal-1',
    sourceId: 'userId:1',
    ...overrides,
  };
}

function buildLineItemPropertyChangePayload(overrides = {}) {
  return {
    eventId: 102,
    subscriptionId: 202,
    portalId: 300,
    appId: 400,
    occurredAt: 1783002936800,
    subscriptionType: 'line_item.propertyChange',
    propertyName: 'lista_de_precios',
    propertyValue: '5',
    changeSource: 'CRM_UI',
    objectId: 'line-1',
    sourceId: 'userId:1',
    ...overrides,
  };
}

describe('DealPriceListLineItemPriceWebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips unsupported events', async () => {
    const { service, syncDealLineItemPrices } = buildService();
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(
      buildDealPropertyChangePayload({ propertyName: 'otra_propiedad' }),
      { tenantModels, tenant: {}, tenantKey: 'tenant_1', strategyConfig: STRATEGY_CONFIG }
    );

    expect(result.meta.reason).toBe('unsupported_event');
    expect(syncDealLineItemPrices.execute).not.toHaveBeenCalled();
  });

  it('recalculates the deal on a DEAL_TO_LINE_ITEM association event', async () => {
    const { service, syncDealLineItemPrices } = buildService();
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(buildAssociationPayload(), {
      tenantModels,
      tenant: {},
      tenantKey: 'tenant_1',
      strategyConfig: STRATEGY_CONFIG,
    });

    expect(syncDealLineItemPrices.execute).toHaveBeenCalledWith(
      { dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG },
      expect.objectContaining({ tenantKey: 'tenant_1' })
    );
    expect(result.meta).toMatchObject({
      handled: true,
      reason: 'deal_line_items_price_list_recalculated',
      eventKind: 'association',
      dealId: 'deal-1',
    });
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      { $set: { isSend: true, errorMessage: null } }
    );
  });

  it('recalculates the deal on a deal.propertyChange of the price list property', async () => {
    const { service, syncDealLineItemPrices } = buildService();
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(buildDealPropertyChangePayload(), {
      tenantModels,
      tenant: {},
      tenantKey: 'tenant_1',
      strategyConfig: STRATEGY_CONFIG,
    });

    expect(syncDealLineItemPrices.execute).toHaveBeenCalledWith(
      { dealId: 'deal-1', strategyConfig: STRATEGY_CONFIG },
      expect.anything()
    );
    expect(result.meta.eventKind).toBe('dealPropertyChange');
  });

  it('resolves the deal from the line item on line_item.propertyChange', async () => {
    const { service, syncDealLineItemPrices, hubspotAuth } = buildService();
    const tenantModels = buildTenantModels();

    mockHubspotGet.mockResolvedValueOnce({
      id: 'line-1',
      associations: { deals: { results: [{ id: 'deal-9' }] } },
    });

    const result = await service.preparePayload(buildLineItemPropertyChangePayload(), {
      tenantModels,
      tenant: {},
      tenantKey: 'tenant_1',
      strategyConfig: STRATEGY_CONFIG,
    });

    expect(hubspotAuth.getAccessToken).toHaveBeenCalled();
    expect(syncDealLineItemPrices.execute).toHaveBeenCalledWith(
      { dealId: 'deal-9', strategyConfig: STRATEGY_CONFIG },
      expect.anything()
    );
    expect(result.meta.dealId).toBe('deal-9');
  });

  it('throws when the line item has no associated deal', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels();

    mockHubspotGet.mockResolvedValueOnce({ id: 'line-1', associations: {} });

    await expect(
      service.preparePayload(buildLineItemPropertyChangePayload(), {
        tenantModels,
        tenant: {},
        tenantKey: 'tenant_1',
        strategyConfig: STRATEGY_CONFIG,
      })
    ).rejects.toThrow('Line item has no associated deal');
    expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'Line item has no associated deal' })
    );
  });

  it('skips duplicate events', async () => {
    const { service, syncDealLineItemPrices } = buildService();
    const tenantModels = buildTenantModels();
    tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
      .mockReturnValueOnce(leanResult({ _id: 'previous' }));

    const result = await service.preparePayload(buildDealPropertyChangePayload(), {
      tenantModels,
      tenant: {},
      tenantKey: 'tenant_1',
      strategyConfig: STRATEGY_CONFIG,
    });

    expect(result.meta.reason).toBe('duplicate_event');
    expect(syncDealLineItemPrices.execute).not.toHaveBeenCalled();
    expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'Duplicate event' })
    );
  });

  it('debounces bursts for the same deal', async () => {
    const { service, syncDealLineItemPrices } = buildService();
    const tenantModels = buildTenantModels();
    tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
      // Duplicado: no hay.
      .mockReturnValueOnce(leanResult(null))
      // Debounce: hay una ejecución reciente del mismo deal.
      .mockReturnValueOnce(leanResult({ _id: 'recent' }));

    const result = await service.preparePayload(buildDealPropertyChangePayload(), {
      tenantModels,
      tenant: {},
      tenantKey: 'tenant_1',
      strategyConfig: STRATEGY_CONFIG,
    });

    expect(result.meta.reason).toBe('debounced_event');
    expect(result.meta.dealId).toBe('deal-1');
    expect(syncDealLineItemPrices.execute).not.toHaveBeenCalled();
  });

  it('marks the event as errored and rethrows when the recalculation fails', async () => {
    const { service, syncDealLineItemPrices } = buildService();
    syncDealLineItemPrices.execute.mockRejectedValueOnce(new Error('SAP unavailable'));
    const tenantModels = buildTenantModels();

    await expect(
      service.preparePayload(buildAssociationPayload(), {
        tenantModels,
        tenant: {},
        tenantKey: 'tenant_1',
        strategyConfig: STRATEGY_CONFIG,
      })
    ).rejects.toThrow('SAP unavailable');
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      { $set: { isSend: false, errorMessage: 'SAP unavailable' } }
    );
  });

  it('rejects property changes not coming from the CRM UI (loop protection)', async () => {
    const { service, syncDealLineItemPrices } = buildService();
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(
      buildLineItemPropertyChangePayload({ changeSource: 'INTEGRATION' }),
      { tenantModels, tenant: {}, tenantKey: 'tenant_1', strategyConfig: STRATEGY_CONFIG }
    );

    expect(result.meta.reason).toBe('unsupported_event');
    expect(syncDealLineItemPrices.execute).not.toHaveBeenCalled();
  });
});
