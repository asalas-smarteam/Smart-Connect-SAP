import { jest } from '@jest/globals';

const mockGetAccessToken = jest.fn();
const mockHubspotGet = jest.fn();

jest.unstable_mockModule('../../src/services/hubspotAuthService.js', () => ({
  default: {
    getAccessToken: mockGetAccessToken,
  },
}));

jest.unstable_mockModule('../../src/services/hubspotClient.js', () => ({
  hubspotGet: mockHubspotGet,
}));

const lineItemPriceWebhookService = (
  await import('../../src/services/lineItemPriceWebhook.service.js')
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
  };
}

describe('lineItemPriceWebhook.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips unsupported association types', async () => {
    const tenantModels = buildTenantModels();

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        associationType: 'DEAL_TO_CONTACT',
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
        reason: 'unsupported_association_type',
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
    mockHubspotGet
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        id: '201',
        properties: {
          idsap: 'CL00129',
        },
      })
      .mockResolvedValueOnce({
        id: '54118822955',
        properties: {
          hs_sku: 'A01050211',
        },
      })
      .mockResolvedValueOnce({
        id: '54118822956',
        properties: {
          hs_sku: 'A01050007',
        },
      });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
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
        cardCode: 'CL00129',
        lineItems: [
          { id: '54118822955', itemCode: 'A01050211' },
          { id: '54118822956', itemCode: 'A01050007' },
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
