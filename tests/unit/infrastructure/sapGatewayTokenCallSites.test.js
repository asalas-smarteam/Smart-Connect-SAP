import { jest } from '@jest/globals';

const mockGetSessionCookie = jest.fn();
const mockResolveTenantKey = jest.fn();
const mockInvalidateSession = jest.fn();
const mockAxios = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
mockAxios.get = mockAxiosGet;
mockAxios.post = mockAxiosPost;

jest.unstable_mockModule('../../../src/infrastructure/sap/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: mockGetSessionCookie,
    resolveTenantKey: mockResolveTenantKey,
    invalidateSession: mockInvalidateSession,
  },
  isSessionInvalidError: (error) => [401, 403].includes(error?.response?.status),
}));

jest.unstable_mockModule('axios', () => ({ default: mockAxios }));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { B1ServiceLayerTransport } = await import(
  '../../../src/infrastructure/sap/transport/B1ServiceLayerTransport.js'
);
const { sapServiceLayerWebhookRequest } = await import(
  '../../../src/infrastructure/sap/sapServiceLayerWebhookRequest.js'
);
const { sapBusinessPartnerAdapter } = await import(
  '../../../src/infrastructure/sap/sap-business-partner.adapter.js'
);
const { SapLineItemPriceClient } = await import(
  '../../../src/infrastructure/external-services/SapLineItemPriceClient.js'
);
const { SapDiscountClient } = await import(
  '../../../src/infrastructure/external-services/SapDiscountClient.js'
);

const TOKEN = 'test-gateway-token';
const baseConfig = { serviceLayerBaseUrl: 'https://sl.example.com/' };
const withToken = { ...baseConfig, serviceLayerGatewayToken: TOKEN };

const headersOfAxiosCall = (mock) => mock.mock.calls[0].at(-1).headers;
const headersOfAxiosObjectCall = (mock) => mock.mock.calls[0][0].headers;

describe('Service Layer gateway token on every call site', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveTenantKey.mockReturnValue('tenant-1');
    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxios.mockResolvedValue({ data: { ok: true } });
    mockAxiosGet.mockResolvedValue({ data: { value: [] } });
    mockAxiosPost.mockResolvedValue({ data: { Price: 1 } });
  });

  describe('B1ServiceLayerTransport', () => {
    it('request sends Authorization alongside the cookie when set', async () => {
      await new B1ServiceLayerTransport({ config: withToken }).request({ path: '/Items' });

      expect(headersOfAxiosObjectCall(mockAxios)).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Cookie: 'B1SESSION=abc',
      });
    });

    it('request lets explicit caller headers win over the gateway header', async () => {
      await new B1ServiceLayerTransport({ config: withToken }).request({
        path: '/Items',
        headers: { Authorization: 'Bearer explicit' },
      });

      expect(headersOfAxiosObjectCall(mockAxios).Authorization).toBe('Bearer explicit');
    });

    it('request sends no Authorization when the token is absent', async () => {
      await new B1ServiceLayerTransport({ config: baseConfig }).request({ path: '/Items' });

      expect(headersOfAxiosObjectCall(mockAxios)).toEqual({ Cookie: 'B1SESSION=abc' });
    });

    it('fetchAll sends Authorization on every paginated page when set', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: { value: [{ a: 1 }], '@odata.nextLink': 'Items?$skip=100' },
        })
        .mockResolvedValueOnce({ data: { value: [{ a: 2 }] } });

      const items = await new B1ServiceLayerTransport({ config: withToken }).fetchAll({
        path: '/Items',
      });

      expect(items).toHaveLength(2);
      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
      mockAxiosGet.mock.calls.forEach(([, options]) => {
        expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(options.headers.Cookie).toBe('B1SESSION=abc');
      });
    });

    it('fetchAll sends no Authorization when the token is absent', async () => {
      await new B1ServiceLayerTransport({ config: baseConfig }).fetchAll({ path: '/Items' });

      expect(headersOfAxiosCall(mockAxiosGet)).not.toHaveProperty('Authorization');
    });
  });

  describe('sapServiceLayerWebhookRequest', () => {
    it('sends Authorization when set and keeps caller headers', async () => {
      await sapServiceLayerWebhookRequest(withToken, {
        method: 'post',
        path: '/Orders',
        data: {},
        headers: { 'B1S-ReplaceCollectionsOnPatch': 'true' },
      });

      expect(headersOfAxiosObjectCall(mockAxios)).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Cookie: 'B1SESSION=abc',
        'B1S-ReplaceCollectionsOnPatch': 'true',
      });
    });

    it('sends no Authorization when the token is absent', async () => {
      await sapServiceLayerWebhookRequest(baseConfig, { method: 'post', path: '/Orders', data: {} });

      expect(headersOfAxiosObjectCall(mockAxios)).toEqual({ Cookie: 'B1SESSION=abc' });
    });
  });

  describe('sapBusinessPartnerAdapter', () => {
    it('sends Authorization when set', async () => {
      await sapBusinessPartnerAdapter.updateBusinessPartner({
        sapConfig: withToken,
        cardCode: 'C1',
        payload: { CardName: 'x' },
      });

      expect(headersOfAxiosObjectCall(mockAxios)).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Cookie: 'B1SESSION=abc',
      });
    });

    it('sends no Authorization when the token is absent', async () => {
      await sapBusinessPartnerAdapter.updateBusinessPartner({
        sapConfig: baseConfig,
        cardCode: 'C1',
        payload: { CardName: 'x' },
      });

      expect(headersOfAxiosObjectCall(mockAxios)).toEqual({ Cookie: 'B1SESSION=abc' });
    });
  });

  describe('SapLineItemPriceClient', () => {
    it('fetchBusinessPartnerPrice sends Authorization when set', async () => {
      await new SapLineItemPriceClient().fetchBusinessPartnerPrice({
        sapConfig: withToken,
        cardCode: 'C1',
        itemCode: 'I1',
        date: '2026-01-01',
        tenantKey: 'tenant-1',
      });

      expect(headersOfAxiosCall(mockAxiosPost)).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Cookie: 'B1SESSION=abc',
      });
    });

    it('fetchBusinessPartnerPrice sends no Authorization when absent', async () => {
      await new SapLineItemPriceClient().fetchBusinessPartnerPrice({
        sapConfig: baseConfig,
        cardCode: 'C1',
        itemCode: 'I1',
        date: '2026-01-01',
        tenantKey: 'tenant-1',
      });

      expect(headersOfAxiosCall(mockAxiosPost)).toEqual({ Cookie: 'B1SESSION=abc' });
    });

    it('fetchItemPrices sends Authorization when set', async () => {
      await new SapLineItemPriceClient().fetchItemPrices({
        sapConfig: withToken,
        itemCode: 'I1',
        tenantKey: 'tenant-1',
      });

      expect(headersOfAxiosCall(mockAxiosGet)).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Cookie: 'B1SESSION=abc',
      });
    });

    it('fetchItemPrices sends no Authorization when absent', async () => {
      await new SapLineItemPriceClient().fetchItemPrices({
        sapConfig: baseConfig,
        itemCode: 'I1',
        tenantKey: 'tenant-1',
      });

      expect(headersOfAxiosCall(mockAxiosGet)).toEqual({ Cookie: 'B1SESSION=abc' });
    });
  });

  describe('SapDiscountClient', () => {
    it('sends Authorization with the cookie and Prefer header when set', async () => {
      await new SapDiscountClient().fetchActiveDiscountGroups({
        sapConfig: withToken,
        tenantKey: 'tenant-1',
      });

      expect(headersOfAxiosCall(mockAxiosGet)).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Cookie: 'B1SESSION=abc',
        Prefer: 'odata.maxpagesize=100',
      });
    });

    it('sends no Authorization when the token is absent', async () => {
      await new SapDiscountClient().fetchActiveDiscountGroups({
        sapConfig: baseConfig,
        tenantKey: 'tenant-1',
      });

      expect(headersOfAxiosCall(mockAxiosGet)).toEqual({
        Cookie: 'B1SESSION=abc',
        Prefer: 'odata.maxpagesize=100',
      });
    });
  });
});
