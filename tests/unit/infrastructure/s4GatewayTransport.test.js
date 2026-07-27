import { jest } from '@jest/globals';

const mockAxios = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { S4GatewayTransport } = await import(
  '../../../src/infrastructure/sap/transport/S4GatewayTransport.js'
);

const config = {
  serviceLayerBaseUrl: 'https://s4.example.com:44300/',
  serviceLayerUsername: 'INTEGRATION',
  serviceLayerPassword: 'secret',
};

describe('S4GatewayTransport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires serviceLayerBaseUrl', () => {
    expect(() => new S4GatewayTransport({ config: {} })).toThrow(
      'serviceLayerBaseUrl is required'
    );
  });

  it('builds GET urls with the gateway prefix, basic auth and $format=json', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { d: { results: [{ BusinessPartner: '10000' }] } },
      headers: {},
    });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: { $top: 2 },
    });

    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=2&$format=json',
        auth: { username: 'INTEGRATION', password: 'secret' },
      })
    );
    expect(result).toEqual([{ BusinessPartner: '10000' }]);
  });

  it('uses /sap/-rooted paths verbatim (catalog service)', async () => {
    mockAxios.mockResolvedValueOnce({ data: { d: { results: [] } }, headers: {} });

    const transport = new S4GatewayTransport({ config });
    await transport.request({
      path: '/sap/opu/odata/iwfnd/catalogservice;v=2/ServiceCollection',
    });

    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://s4.example.com:44300/sap/opu/odata/iwfnd/catalogservice;v=2/ServiceCollection?$format=json',
      })
    );
  });

  it('normalizes dates and strips metadata in responses', async () => {
    mockAxios.mockResolvedValueOnce({
      data: {
        d: {
          __metadata: { uri: 'x' },
          BusinessPartner: '10000',
          CreationDate: '/Date(1659571200000)/',
          CreationTime: 'PT20H40M35S',
        },
      },
      headers: {},
    });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      path: "/API_BUSINESS_PARTNER/A_BusinessPartner('10000')",
    });

    expect(result).toEqual({
      BusinessPartner: '10000',
      CreationDate: '2022-08-04T00:00:00.000Z',
      CreationTime: '20:40:35',
    });
  });

  it('follows __next links across pages in fetchAll', async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {
          d: {
            results: [{ BusinessPartner: '10000' }],
            __next: 'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$skiptoken=1&$format=json',
          },
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        data: { d: { results: [{ BusinessPartner: '10001' }] } },
        headers: {},
      });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.fetchAll({
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: { $select: 'BusinessPartner' },
    });

    expect(result).toEqual([
      { BusinessPartner: '10000' },
      { BusinessPartner: '10001' },
    ]);
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(mockAxios.mock.calls[1][0].url).toBe(
      'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$skiptoken=1&$format=json'
    );
  });

  it('fetches a CSRF token before writes and sends it with the session cookie', async () => {
    mockAxios
      // CSRF fetch on the service document
      .mockResolvedValueOnce({
        data: {},
        headers: {
          'x-csrf-token': 'token-abc',
          'set-cookie': ['SAP_SESSIONID=xyz; path=/', 'sap-usercontext=uc; path=/'],
        },
      })
      // Actual write
      .mockResolvedValueOnce({
        data: { d: { BusinessPartner: '10002' } },
        headers: {},
      });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      method: 'post',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      body: { BusinessPartnerCategory: '2' },
    });

    expect(mockAxios.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        method: 'get',
        url: 'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/?$format=json',
        headers: { 'x-csrf-token': 'Fetch' },
      })
    );
    expect(mockAxios.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        method: 'post',
        headers: expect.objectContaining({
          'x-csrf-token': 'token-abc',
          Cookie: 'SAP_SESSIONID=xyz; sap-usercontext=uc',
        }),
      })
    );
    expect(result).toEqual({ BusinessPartner: '10002' });
  });

  it('refreshes the CSRF token once when the gateway rejects it', async () => {
    const csrfRejection = new Error('CSRF token validation failed');
    csrfRejection.response = {
      status: 403,
      headers: { 'x-csrf-token': 'Required' },
    };

    mockAxios
      // initial CSRF fetch
      .mockResolvedValueOnce({
        data: {},
        headers: { 'x-csrf-token': 'stale-token', 'set-cookie': [] },
      })
      // write rejected
      .mockRejectedValueOnce(csrfRejection)
      // refreshed CSRF fetch
      .mockResolvedValueOnce({
        data: {},
        headers: { 'x-csrf-token': 'fresh-token', 'set-cookie': [] },
      })
      // retried write
      .mockResolvedValueOnce({ data: { d: { ok: true } }, headers: {} });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      method: 'post',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      body: {},
    });

    expect(result).toEqual({ ok: true });
    expect(mockAxios).toHaveBeenCalledTimes(4);
    expect(mockAxios.mock.calls[3][0].headers).toEqual(
      expect.objectContaining({ 'x-csrf-token': 'fresh-token' })
    );
  });

  it('propagates non-CSRF errors without retrying', async () => {
    const serverError = new Error('boom');
    serverError.response = { status: 500, headers: {} };

    mockAxios
      .mockResolvedValueOnce({
        data: {},
        headers: { 'x-csrf-token': 'token', 'set-cookie': [] },
      })
      .mockRejectedValueOnce(serverError);

    const transport = new S4GatewayTransport({ config });

    await expect(
      transport.request({ method: 'post', path: '/API_BUSINESS_PARTNER/A_BusinessPartner', body: {} })
    ).rejects.toThrow('boom');
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });
});
