import { jest } from '@jest/globals';

const mockGetSessionCookie = jest.fn();
const mockResolveTenantKey = jest.fn();
const mockInvalidateSession = jest.fn();
const mockAxiosGet = jest.fn();

jest.unstable_mockModule('../../src/services/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: mockGetSessionCookie,
    resolveTenantKey: mockResolveTenantKey,
    invalidateSession: mockInvalidateSession,
  },
  isSessionInvalidError: (error) => [401, 403].includes(error?.response?.status),
}));

jest.unstable_mockModule('axios', () => ({
  default: {
    get: mockAxiosGet,
  },
}));

const serviceLayerService = (await import('../../src/services/serviceLayer.service.js')).default;

describe('serviceLayerService.execute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveTenantKey.mockReturnValue('tenant-1');
  });

  const config = {
    integrationModeName: 'SERVICE_LAYER',
    serviceLayerBaseUrl: 'https://sap.example.com:50000',
    serviceLayerPath: '/BusinessPartners',
    intervalMinutes: 0,
  };

  const mappings = [{ sourceField: 'CardCode' }];

  it('uses one session cookie for paginated requests', async () => {
    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          value: [{ CardCode: 'C1' }],
          '@odata.nextLink': '/b1s/v2/BusinessPartners?$skip=20',
        },
      })
      .mockResolvedValueOnce({ data: { value: [{ CardCode: 'C2' }] } });

    const result = await serviceLayerService.execute(config, mappings);

    expect(result).toEqual([{ CardCode: 'C1' }, { CardCode: 'C2' }]);
    expect(mockGetSessionCookie).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    expect(mockAxiosGet.mock.calls[0][0]).toBe('https://sap.example.com:50000/b1s/v2/BusinessPartners?$select=CardCode');
    expect(mockAxiosGet.mock.calls[0][1].headers.Cookie).toBe('B1SESSION=abc');
    expect(mockAxiosGet.mock.calls[1][0]).toBe('https://sap.example.com:50000/b1s/v2/b1s/v2/BusinessPartners?$skip=20');
  });

  it('invalidates and retries once when session is invalid', async () => {
    mockGetSessionCookie
      .mockResolvedValueOnce({ cookie: 'B1SESSION=expired' })
      .mockResolvedValueOnce({ cookie: 'B1SESSION=fresh' });

    const unauthorized = new Error('unauthorized');
    unauthorized.response = { status: 401 };

    mockAxiosGet
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({ data: { value: [{ CardCode: 'C3' }] } });

    const result = await serviceLayerService.execute(config, mappings);

    expect(result).toEqual([{ CardCode: 'C3' }]);
    expect(mockInvalidateSession).toHaveBeenCalledWith('tenant-1');
    expect(mockGetSessionCookie).toHaveBeenCalledTimes(2);
  });
});
