import { jest } from '@jest/globals';

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockGetAccessToken = jest.fn();
const mockBatchUpdateLineItems = jest.fn();
const mockUpdateDeal = jest.fn();
const mockGetSessionCookie = jest.fn();
const mockInvalidateSession = jest.fn();
const mockResolveTenantKey = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: {
    post: mockAxiosPost,
    get: mockAxiosGet,
  },
}));

jest.unstable_mockModule('../../src/services/hubspotAuthService.js', () => ({
  default: {
    getAccessToken: mockGetAccessToken,
  },
}));

jest.unstable_mockModule('../../src/services/hubspotClient.js', () => ({
  batchUpdateLineItems: mockBatchUpdateLineItems,
  updateDeal: mockUpdateDeal,
}));

jest.unstable_mockModule('../../src/services/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: mockGetSessionCookie,
    invalidateSession: mockInvalidateSession,
    resolveTenantKey: mockResolveTenantKey,
  },
  isSessionInvalidError: (error) => [401, 403].includes(error?.response?.status),
}));

jest.unstable_mockModule('../../src/core/logger.js', () => ({
  default: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
  },
}));

const lineItemPriceService = (await import('../../src/services/lineItemPrice.service.js')).default;

describe('lineItemPrice.service syncPrices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-04-08T12:00:00.000Z'));
    mockResolveTenantKey.mockReturnValue('tenant_1');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function buildTenantModels() {
    return {
      HubspotCredentials: {
        findOne: jest.fn()
          .mockResolvedValueOnce({
            _id: 'hubspot-credential-1',
            clientConfigId: 'client-config-1',
            portalId: '12345',
          }),
      },
      SapCredentials: {
        findOne: jest.fn()
          .mockResolvedValueOnce({
            clientConfigId: 'client-config-1',
            serviceLayerBaseUrl: 'https://sap.example.com:50000',
            serviceLayerUsername: 'manager',
            serviceLayerPassword: 'secret',
            serviceLayerCompanyDB: 'SBODEMO',
          }),
      },
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'priceList',
          value: '4',
          userUpdated: 'admin',
        }),
      },
    };
  }

  it('retrieves SAP prices and updates HubSpot line items', async () => {
    const tenantModels = buildTenantModels();

    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxiosPost
      .mockResolvedValueOnce({
        data: { Price: 704.35, Currency: 'C$', Discount: 0.0 },
      })
      .mockResolvedValueOnce({
        data: { Price: 825.1, Currency: 'C$', Discount: 5.0 },
      });
    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockBatchUpdateLineItems.mockResolvedValue({
      results: [{ id: '53747313682' }, { id: '54118679348' }],
    });
    mockUpdateDeal.mockResolvedValue({ id: 'deal-1' });

    const result = await lineItemPriceService.syncPrices(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [
          { itemCode: 'A0001', id: '53747313682', quantity: 2 },
          { itemCode: 'A0002', id: '54118679348', quantity: 0 },
        ],
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '12345' } } },
        tenantKey: 'tenant_1',
      }
    );

    expect(result).toEqual({
      data: {
        cardCode: 'C20000',
        dealId: 'deal-1',
        totalAmount: 2233.8,
        lineItems: [
          {
            itemCode: 'A0001',
            id: '53747313682',
            quantity: 2,
            Price: 704.35,
            Currency: 'C$',
            Discount: 0.0,
            lineTotal: 1408.7,
          },
          {
            itemCode: 'A0002',
            id: '54118679348',
            quantity: 1,
            Price: 825.1,
            Currency: 'C$',
            Discount: 5.0,
            lineTotal: 825.1,
          },
        ],
      },
      meta: {
        requestedCount: 2,
        updatedCount: 2,
        dealUpdated: true,
      },
    });

    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      'https://sap.example.com:50000/b1s/v2/CompanyService_GetItemPrice',
      {
        ItemPriceParams: {
          ItemCode: 'A0001',
          CardCode: 'C20000',
          Date: '2026-04-08',
        },
      },
      expect.objectContaining({
        timeout: 15000,
        headers: { Cookie: 'B1SESSION=abc' },
      })
    );

    expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
      inputs: [
        {
          id: '53747313682',
          properties: { price: '704.35', quantity: '2' },
        },
        {
          id: '54118679348',
          properties: { price: '825.1', quantity: '1' },
        },
      ],
    });
    expect(mockUpdateDeal).toHaveBeenCalledWith('hubspot-token', 'deal-1', {
      properties: { amount: '2233.8' },
    });
  });

  it('invalidates SAP session and retries when SAP returns unauthorized', async () => {
    const tenantModels = buildTenantModels();
    const unauthorized = new Error('Unauthorized');
    unauthorized.response = { status: 401 };

    mockGetSessionCookie
      .mockResolvedValueOnce({ cookie: 'B1SESSION=expired' })
      .mockResolvedValueOnce({ cookie: 'B1SESSION=fresh' });
    mockAxiosPost
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({
        data: { Price: 704.35, Currency: 'C$', Discount: 0.0 },
      });
    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockBatchUpdateLineItems.mockResolvedValue({ results: [{ id: '53747313682' }] });
    mockUpdateDeal.mockResolvedValue({ id: 'deal-1' });

    const resultPromise = lineItemPriceService.syncPrices(
      {
        dealId: 'deal-1',
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: '53747313682', quantity: 0 }],
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '12345' } } },
        tenantKey: 'tenant_1',
      }
    );
    await jest.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result.meta).toEqual({
      requestedCount: 1,
      updatedCount: 1,
      dealUpdated: true,
    });
    expect(mockInvalidateSession).toHaveBeenCalledWith('tenant_1');
    expect(mockGetSessionCookie).toHaveBeenCalledTimes(2);
  });

  it('attaches webhook audit details when HubSpot update fails', async () => {
    jest.useRealTimers();
    const tenantModels = buildTenantModels();

    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxiosPost.mockResolvedValue({
      data: { Price: 704.35, Currency: 'C$', Discount: 0.0 },
    });
    mockGetAccessToken.mockResolvedValue('hubspot-token');

    const hubspotError = new Error('HubSpot API request failed: 500 Internal Server Error');
    hubspotError.details = {
      status: 500,
      message: 'HubSpot exploded',
    };
    mockBatchUpdateLineItems.mockRejectedValue(hubspotError);

    await expect(
      lineItemPriceService.syncPrices(
        {
          dealId: 'deal-1',
          cardCode: 'C20000',
          lineItems: [{ itemCode: 'A0001', id: '53747313682', quantity: 2 }],
        },
        {
          tenantModels,
          tenant: { client: { hubspot: { portalId: '12345' } } },
          tenantKey: 'tenant_1',
        }
      )
    ).rejects.toMatchObject({
      syncLogWebhookErrors: [
        {
          payload_Hubspot: {
            dealId: 'deal-1',
            cardCode: 'C20000',
            lineItems: [{ itemCode: 'A0001', id: '53747313682', quantity: 2 }],
          },
          payload_SAP: [
            {
              ItemPriceParams: {
                ItemCode: 'A0001',
                CardCode: 'C20000',
                Date: expect.any(String),
              },
            },
          ],
          response_hubspot: {
            error: {
              message: 'HubSpot API request failed: 500 Internal Server Error',
            },
          },
          response_SAP: [
            { Price: 704.35, Currency: 'C$', Discount: 0.0 },
          ],
        },
      ],
    });
  });

  it('uses tenant priceList config when cardCode is missing', async () => {
    const tenantModels = buildTenantModels();

    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          ItemPrices: [
            { PriceList: 1, Price: 900, Currency: 'C$' },
            { PriceList: 4, Price: 704.35, Currency: 'C$' },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          ItemPrices: [
            { PriceList: 4, Price: 825.1, Currency: 'C$' },
          ],
        },
      });
    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockBatchUpdateLineItems.mockResolvedValue({
      results: [{ id: '53747313682' }, { id: '54118679348' }],
    });
    mockUpdateDeal.mockResolvedValue({ id: 'deal-1' });

    const result = await lineItemPriceService.syncPrices(
      {
        dealId: 'deal-1',
        lineItems: [
          { itemCode: 'A0001', id: '53747313682', quantity: 3 },
          { itemCode: 'A0002', id: '54118679348', quantity: 0 },
        ],
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '12345' } } },
        tenantKey: 'tenant_1',
      }
    );

    expect(result).toEqual({
      data: {
        cardCode: null,
        dealId: 'deal-1',
        totalAmount: 2938.15,
        lineItems: [
          {
            itemCode: 'A0001',
            id: '53747313682',
            quantity: 3,
            Price: 704.35,
            Currency: 'C$',
            Discount: 0,
            lineTotal: 2113.05,
          },
          {
            itemCode: 'A0002',
            id: '54118679348',
            quantity: 1,
            Price: 825.1,
            Currency: 'C$',
            Discount: 0,
            lineTotal: 825.1,
          },
        ],
      },
      meta: {
        requestedCount: 2,
        updatedCount: 2,
        dealUpdated: true,
      },
    });

    expect(tenantModels.Configuration.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'priceList' },
      {
        $setOnInsert: {
          key: 'priceList',
          value: '4',
          userUpdated: 'admin',
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      1,
      "https://sap.example.com:50000/b1s/v2/Items('A0001')?$select=ItemPrices",
      expect.objectContaining({
        timeout: 15000,
        headers: { Cookie: 'B1SESSION=abc' },
      })
    );
    expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
      inputs: [
        {
          id: '53747313682',
          properties: { price: '704.35', quantity: '3' },
        },
        {
          id: '54118679348',
          properties: { price: '825.1', quantity: '1' },
        },
      ],
    });
    expect(mockUpdateDeal).toHaveBeenCalledWith('hubspot-token', 'deal-1', {
      properties: { amount: '2938.15' },
    });
  });
});
