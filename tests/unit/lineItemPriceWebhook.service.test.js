import { jest } from '@jest/globals';

const mockGetAccessToken = jest.fn();
const mockHubspotGet = jest.fn();
const mockBatchUpdateLineItems = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotAuthService.js', () => ({
  default: {
    getAccessToken: mockGetAccessToken,
  },
}));

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  hubspotGet: mockHubspotGet,
  batchUpdateLineItems: mockBatchUpdateLineItems,
}));

const lineItemPriceWebhookService = (
  await import('../../src/infrastructure/webhook/lineItemPriceWebhook.service.js')
).default;

function buildTenantModels() {
  return {
    HubspotCredentials: {
      findOne: jest.fn()
        .mockResolvedValueOnce({
          clientConfigId: 'client-config-1',
          portalId: '50564010',
          accessToken: 'access-token',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
    },
    LineItemPriceWebhookEvent: {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      }),
      create: jest.fn().mockResolvedValue({ _id: 'event-1' }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    },
    Configuration: {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue({ value: undefined }),
    },
  };
}

function mockConfigurationValues(tenantModels, values) {
  tenantModels.Configuration.findOneAndUpdate = jest.fn().mockImplementation(
    async ({ key }) => ({ value: values[key] })
  );
}

function leanResult(value) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function buildPropertyChangePayload(overrides = {}) {
  return {
    eventId: 1858073298,
    subscriptionId: 6948787,
    portalId: 50249912,
    appId: 36665006,
    occurredAt: 1783002936606,
    subscriptionType: 'line_item.propertyChange',
    attemptNumber: 0,
    objectId: 56816252584,
    propertyName: 'miscelaneo',
    propertyValue: '10',
    changeSource: 'CRM_UI',
    sourceId: 'userId:82534997',
    ...overrides,
  };
}

function mockDealWithLineItems(itemsByPath) {
  mockHubspotGet.mockImplementation(async (_token, path, params = {}) => {
    if (path === '/crm/v3/objects/line_items/56816252584' && params.associations === 'deals') {
      return {
        id: '56816252584',
        associations: { deals: { results: [{ id: '900100' }] } },
      };
    }

    if (path === '/crm/v3/objects/deals/900100') {
      // HubSpot devuelve la asociación de line items con espacio: "line items".
      return {
        id: '900100',
        associations: {
          'line items': {
            results: Object.keys(itemsByPath).map((id) => ({ id })),
          },
        },
      };
    }

    const itemId = path.replace('/crm/v3/objects/line_items/', '');
    if (itemsByPath[itemId]) {
      return { id: itemId, properties: itemsByPath[itemId] };
    }

    return null;
  });
}

describe('lineItemPriceWebhook.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockReset();
    mockHubspotGet.mockReset();
    mockBatchUpdateLineItems.mockReset();
  });

  it('skips events that are not DEAL_TO_LINE_ITEM from USER', async () => {
    const tenantModels = buildTenantModels();

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        associationType: 'DEAL_TO_CONTACT',
        changeSource: 'USER',
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: {
        skipped: true,
        reason: 'unsupported_event',
      },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.findOne).not.toHaveBeenCalled();
  });

  it('skips events when changeSource is not USER', async () => {
    const tenantModels = buildTenantModels();

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'INTEGRATION',
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: {
        skipped: true,
        reason: 'unsupported_event',
      },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.findOne).not.toHaveBeenCalled();
  });

  it('skips duplicated webhook payloads', async () => {
    const tenantModels = buildTenantModels();
    tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'event-1' }),
      }),
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: 'event-1',
      meta: {
        skipped: true,
        reason: 'duplicate_event',
      },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('builds the legacy payload from the HubSpot deal associations', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/58986911596') {
        return {
          id: '58986911596',
          associations: {
            companies: {
              results: [{ id: '201' }],
            },
            contacts: {
              results: [{ id: '301' }],
            },
            line_items: {
              results: [{ id: '54118822955' }, { id: '54118822956' }],
            },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/201') {
        return {
          id: '201',
          properties: {
            idsap: 'CL00129',
          },
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822955') {
        return {
          id: '54118822955',
          properties: {
            hs_sku: 'A01050211',
            quantity: '2',
          },
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822956') {
        return {
          id: '54118822956',
          properties: {
            hs_sku: 'A01050007',
            quantity: '0',
          },
        };
      }

      return null;
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: false,
      payload: {
        dealId: '58986911596',
        cardCode: 'CL00129',
        lineItems: [
          { id: '54118822955', itemCode: 'A01050211', quantity: '2' },
          { id: '54118822956', itemCode: 'A01050007', quantity: '0' },
        ],
      },
      executionId: 'event-1',
    });

    expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
      payload: {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      isSend: false,
      errorMessage: null,
    });

    expect(mockHubspotGet).toHaveBeenNthCalledWith(
      1,
      'hubspot-token',
      '/crm/v3/objects/deals/58986911596',
      { associations: 'companies,contacts,line_items' }
    );
  });

  it('includes configured misc line item property in the legacy payload', async () => {
    const tenantModels = buildTenantModels();

    tenantModels.Configuration.findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        key: 'requireExtraValueInUnitPrice',
        value: {
          enableMiscPriceCalculation: true,
          originalPriceTargetProperty: 'safe_amount',
          miscSourceProperty: 'misc',
          miscCalculationType: 'porcentual',
        },
      }),
    });

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/58986911596') {
        return {
          id: '58986911596',
          associations: {
            companies: { results: [{ id: '201' }] },
            contacts: { results: [] },
            line_items: { results: [{ id: '54118822955' }] },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/201') {
        return {
          id: '201',
          properties: { idsap: 'CL00129' },
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822955') {
        return {
          id: '54118822955',
          properties: {
            hs_sku: 'A01050211',
            quantity: '2',
            misc: '15',
          },
        };
      }

      return null;
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result.payload.lineItems).toEqual([
      { id: '54118822955', itemCode: 'A01050211', quantity: '2', misc: '15' },
    ]);
    expect(mockHubspotGet).toHaveBeenCalledWith(
      'hubspot-token',
      '/crm/v3/objects/line_items/54118822955',
      { properties: 'hs_sku,quantity,misc' }
    );
  });

  it('stores the error message when the HubSpot preprocessing fails', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockResolvedValueOnce({
      id: '58986911596',
      associations: {
        companies: { results: [] },
        contacts: { results: [] },
        line_items: { results: [] },
      },
    });

    await expect(
      lineItemPriceWebhookService.preparePayload(
        {
          eventId: 797713315,
          subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
        {
          tenantModels,
          tenant: { client: { hubspot: { portalId: '50564010' } } },
        }
      )
    ).rejects.toThrow('Associated company or contact is required for the deal');

    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: {
          isSend: false,
          errorMessage: 'Associated company or contact is required for the deal',
        },
      }
    );
  });

  it('returns payload without cardCode when company and contact have no sapId', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/58986911596') {
        return {
          id: '58986911596',
          associations: {
            companies: {
              results: [{ id: '201' }],
            },
            contacts: {
              results: [{ id: '301' }],
            },
            line_items: {
              results: [{ id: '54118822955' }],
            },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/201') {
        return {
          id: '201',
          properties: {},
        };
      }

      if (path === '/crm/v3/objects/contacts/301') {
        return {
          id: '301',
          properties: {},
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822955') {
        return {
          id: '54118822955',
          properties: {
            hs_sku: 'A01050211',
            quantity: '0',
          },
        };
      }

      return null;
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: false,
      payload: {
        dealId: '58986911596',
        cardCode: null,
        lineItems: [
          { id: '54118822955', itemCode: 'A01050211', quantity: '0' },
        ],
      },
      executionId: 'event-1',
    });
  });

  describe('propertyChange SkippedVersion flow', () => {
    const tenant = { client: { hubspot: { portalId: '50249912' } } };

    it('runs the legacy single line item flow when the mode config is the default', async () => {
      const tenantModels = buildTenantModels();

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockHubspotGet.mockResolvedValue({
        id: '56816252584',
        properties: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload(),
        { tenantModels, tenant }
      );

      expect(result.meta.reason).toBe('line_item_price_recalculated');
      expect(mockHubspotGet).toHaveBeenCalledTimes(1);
      expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
        inputs: [{ id: '56816252584', properties: { price: '110' } }],
      });
    });

    it('skips duplicated property change events and records them as Duplicate event', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
      });
      tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
        .mockReturnValueOnce(leanResult({ _id: 'existing-event' }));

      const payload = buildPropertyChangePayload();
      const result = await lineItemPriceWebhookService.preparePayload(
        payload,
        { tenantModels, tenant }
      );

      expect(result).toEqual({
        skip: true,
        payload: null,
        executionId: null,
        meta: {
          skipped: true,
          reason: 'duplicate_event',
        },
      });
      expect(tenantModels.LineItemPriceWebhookEvent.findOne).toHaveBeenCalledWith({
        'payload.objectId': payload.objectId,
        'payload.sourceId': payload.sourceId,
        'payload.propertyValue': payload.propertyValue,
        'payload.occurredAt': payload.occurredAt,
        $or: [{ isSend: true }, { errorMessage: null }],
      });
      expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
        payload,
        isSend: false,
        errorMessage: 'Duplicate event',
      });
      expect(mockGetAccessToken).not.toHaveBeenCalled();
      expect(mockHubspotGet).not.toHaveBeenCalled();
      expect(mockBatchUpdateLineItems).not.toHaveBeenCalled();
    });

    it('processes a HubSpot retry after a previous failed attempt instead of marking it duplicate', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });
      // El registro fallido previo no matchea el filtro ($or excluye errorMessage != null),
      // por eso el findOne del duplicado resuelve null y el reintento procesa normal.
      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload({ attemptNumber: 1 }),
        { tenantModels, tenant }
      );

      expect(result.meta.reason).toBe('deal_line_items_price_recalculated');
      expect(mockBatchUpdateLineItems).toHaveBeenCalledTimes(1);
    });

    it('debounces events for a deal already processed within the configured window', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });
      tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
        .mockReturnValueOnce(leanResult(null))
        .mockReturnValueOnce(leanResult({ _id: 'recent-execution' }));

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({});

      const payload = buildPropertyChangePayload();
      const result = await lineItemPriceWebhookService.preparePayload(
        payload,
        { tenantModels, tenant }
      );

      expect(result).toEqual({
        skip: true,
        payload: null,
        executionId: null,
        meta: {
          skipped: true,
          reason: 'debounced_event',
          dealId: '900100',
        },
      });

      const debounceFilter = tenantModels.LineItemPriceWebhookEvent.findOne.mock.calls[1][0];
      expect(debounceFilter.dealId).toBe('900100');
      expect(debounceFilter.errorMessage).toBeNull();
      expect(debounceFilter.createdAt.$gte).toBeInstanceOf(Date);

      expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
        payload,
        dealId: '900100',
        isSend: false,
        errorMessage: 'evento skipeado por envios multiples',
      });
      expect(mockBatchUpdateLineItems).not.toHaveBeenCalled();
    });

    it('recalculates every line item of the deal using each item misc value', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
        'li-2': { price: '200', safe_price_value: '200' },
        'li-3': { price: '50', miscelaneo: '50', safe_price_value: '50' },
      });

      const payload = buildPropertyChangePayload();
      const result = await lineItemPriceWebhookService.preparePayload(
        payload,
        { tenantModels, tenant }
      );

      expect(result.skip).toBe(true);
      expect(result.executionId).toBe('event-1');
      expect(result.meta).toMatchObject({
        skipped: false,
        handled: true,
        reason: 'deal_line_items_price_recalculated',
        dealId: '900100',
        requestedCount: 3,
        updatedCount: 3,
      });

      expect(mockBatchUpdateLineItems).toHaveBeenCalledTimes(1);
      expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
        inputs: [
          { id: '56816252584', properties: { price: '110' } },
          { id: 'li-2', properties: { price: '200' } },
          { id: 'li-3', properties: { price: '75' } },
        ],
      });

      expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
        payload,
        dealId: '900100',
        isSend: false,
        errorMessage: null,
      });
      const createOrder = tenantModels.LineItemPriceWebhookEvent.create.mock.invocationCallOrder[0];
      const batchOrder = mockBatchUpdateLineItems.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(batchOrder);

      expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
        { _id: 'event-1' },
        { $set: { isSend: true, errorMessage: null } }
      );
    });

    it('excludes line items without safe_price_value from the batch update', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
        'li-2': { price: '200', miscelaneo: '5' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload(),
        { tenantModels, tenant }
      );

      expect(result.meta).toMatchObject({ requestedCount: 2, updatedCount: 1 });
      expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
        inputs: [{ id: '56816252584', properties: { price: '110' } }],
      });
    });

    it('fails when no line item has safe_price_value and records the error', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10' },
      });

      await expect(
        lineItemPriceWebhookService.preparePayload(
          buildPropertyChangePayload(),
          { tenantModels, tenant }
        )
      ).rejects.toThrow('safe_price_value is required to recalculate line item price');

      expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
        { _id: 'event-1' },
        {
          $set: {
            isSend: false,
            errorMessage: 'safe_price_value is required to recalculate line item price',
          },
        }
      );
      expect(mockBatchUpdateLineItems).not.toHaveBeenCalled();
    });

    it('does not query the debounce window when requireSkipped is false', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: false, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload(),
        { tenantModels, tenant }
      );

      expect(result.meta.reason).toBe('deal_line_items_price_recalculated');
      expect(tenantModels.LineItemPriceWebhookEvent.findOne).toHaveBeenCalledTimes(1);
      expect(mockBatchUpdateLineItems).toHaveBeenCalledTimes(1);
    });

    it('records the error on the created event when the HubSpot batch update fails', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });
      mockBatchUpdateLineItems.mockRejectedValue(new Error('HubSpot batch update failed'));

      await expect(
        lineItemPriceWebhookService.preparePayload(
          buildPropertyChangePayload(),
          { tenantModels, tenant }
        )
      ).rejects.toThrow('HubSpot batch update failed');

      expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
        { _id: 'event-1' },
        { $set: { isSend: false, errorMessage: 'HubSpot batch update failed' } }
      );
    });
  });

  it('marks a processed webhook as sent', async () => {
    const LineItemPriceWebhookEvent = {
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };

    await lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, 'event-1');

    expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: {
          isSend: true,
          errorMessage: null,
        },
      }
    );
  });
});
