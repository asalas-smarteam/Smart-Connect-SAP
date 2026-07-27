import { jest } from '@jest/globals';

const mockGetSessionCookie = jest.fn();
const mockResolveTenantKey = jest.fn();
const mockInvalidateSession = jest.fn();
const mockAxios = jest.fn();
const mockAxiosGet = jest.fn();
mockAxios.get = mockAxiosGet;

jest.unstable_mockModule('../../../src/infrastructure/sap/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: mockGetSessionCookie,
    resolveTenantKey: mockResolveTenantKey,
    invalidateSession: mockInvalidateSession,
  },
  isSessionInvalidError: (error) => [401, 403].includes(error?.response?.status),
}));

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

const { B1ServiceLayerTransport } = await import(
  '../../../src/infrastructure/sap/transport/B1ServiceLayerTransport.js'
);

const config = {
  serviceLayerBaseUrl: 'https://sap.example.com:50000/',
  serviceLayerUsername: 'manager',
  serviceLayerPassword: 'secret',
};

describe('B1ServiceLayerTransport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveTenantKey.mockReturnValue('tenant-1');
  });

  it('requires serviceLayerBaseUrl', () => {
    expect(() => new B1ServiceLayerTransport({ config: {} })).toThrow(
      'serviceLayerBaseUrl is required'
    );
  });

  it('prefixes /b1s/v2, sends the session cookie and unwraps value arrays', async () => {
    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxios.mockResolvedValueOnce({
      data: { value: [{ CardCode: 'C1' }] },
    });

    const transport = new B1ServiceLayerTransport({ config });
    const result = await transport.request({
      path: '/BusinessPartners',
      query: { $select: 'CardCode', $top: 1 },
    });

    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://sap.example.com:50000/b1s/v2/BusinessPartners?$select=CardCode&$top=1',
        headers: expect.objectContaining({ Cookie: 'B1SESSION=abc' }),
      })
    );
    expect(result).toEqual([{ CardCode: 'C1' }]);
  });

  it('returns single entities as-is', async () => {
    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxios.mockResolvedValueOnce({
      data: { CardCode: 'C1', CardName: 'Acme' },
    });

    const transport = new B1ServiceLayerTransport({ config });
    const result = await transport.request({ path: "/BusinessPartners('C1')" });

    expect(result).toEqual({ CardCode: 'C1', CardName: 'Acme' });
  });

  it('invalidates the session and retries once on 401', async () => {
    const unauthorized = new Error('unauthorized');
    unauthorized.response = { status: 401 };

    mockGetSessionCookie
      .mockResolvedValueOnce({ cookie: 'B1SESSION=stale' })
      .mockResolvedValueOnce({ cookie: 'B1SESSION=fresh' });
    mockAxios
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({ data: { value: [] } });

    const transport = new B1ServiceLayerTransport({ config });
    const result = await transport.request({ path: '/Orders' });

    expect(mockInvalidateSession).toHaveBeenCalledWith('tenant-1');
    expect(mockGetSessionCookie).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it('follows @odata.nextLink pagination with one session cookie', async () => {
    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          value: [{ CardCode: 'C1' }],
          '@odata.nextLink': '/b1s/v2/BusinessPartners?$skip=100',
        },
      })
      .mockResolvedValueOnce({
        data: { value: [{ CardCode: 'C2' }] },
      });

    const transport = new B1ServiceLayerTransport({ config });
    const result = await transport.fetchAll({
      path: '/BusinessPartners',
      query: { $select: 'CardCode' },
    });

    expect(result).toEqual([{ CardCode: 'C1' }, { CardCode: 'C2' }]);
    expect(mockGetSessionCookie).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet.mock.calls[0][1].headers).toEqual(
      expect.objectContaining({ Prefer: 'odata.maxpagesize=100' })
    );
    expect(mockAxiosGet.mock.calls[1][0]).toBe(
      'https://sap.example.com:50000/b1s/v2/BusinessPartners?$skip=100'
    );
  });
});
