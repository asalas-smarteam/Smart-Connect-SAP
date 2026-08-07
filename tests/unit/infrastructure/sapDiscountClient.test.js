import { jest } from '@jest/globals';

const mockGetSessionCookie = jest.fn();
const mockResolveTenantKey = jest.fn();
const mockInvalidateSession = jest.fn();
const mockAxiosGet = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/sap/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: mockGetSessionCookie,
    resolveTenantKey: mockResolveTenantKey,
    invalidateSession: mockInvalidateSession,
  },
  isSessionInvalidError: (error) => [401, 403].includes(error?.response?.status),
}));

jest.unstable_mockModule('axios', () => ({
  default: { get: mockAxiosGet },
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { default: logger } = await import('../../../src/infrastructure/logger/logger.js');
const { SapDiscountClient } = await import(
  '../../../src/infrastructure/external-services/SapDiscountClient.js'
);

const sapConfig = { serviceLayerBaseUrl: 'https://sap.example.com:50000/' };

describe('SapDiscountClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveTenantKey.mockReturnValue('tenant-1');
    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
  });

  it('requires a Service Layer base URL', async () => {
    await expect(
      new SapDiscountClient().fetchActiveDiscountGroups({ sapConfig: {}, tenantKey: 'tenant-1' })
    ).rejects.toThrow('SAP Service Layer base URL is required');
  });

  it('walks @odata.nextLink and returns every discount group', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          value: [{ AbsEntry: 1 }],
          '@odata.nextLink': 'EnhancedDiscountGroups?$skip=100',
        },
      })
      .mockResolvedValueOnce({ data: { value: [{ AbsEntry: 2 }, { AbsEntry: 3 }] } });

    const result = await new SapDiscountClient().fetchActiveDiscountGroups({
      sapConfig,
      tenantKey: 'tenant-1',
    });

    expect(result).toEqual([{ AbsEntry: 1 }, { AbsEntry: 2 }, { AbsEntry: 3 }]);
    expect(mockAxiosGet.mock.calls[1][0]).toBe(
      'https://sap.example.com:50000/b1s/v2/EnhancedDiscountGroups?$skip=100'
    );
  });

  it('sends the session cookie, the page size hint and the external timeout', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { value: [] } });

    await new SapDiscountClient().fetchActiveDiscountGroups({ sapConfig, tenantKey: 'tenant-1' });

    expect(mockAxiosGet.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        timeout: 30000,
        headers: { Cookie: 'B1SESSION=abc', Prefer: 'odata.maxpagesize=100' },
      })
    );
  });

  // The per-page trace survived the move to the shared walker: it is the only
  // progress signal this endpoint emits while a long collection is downloading.
  it('logs progress for every page', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({
        data: { value: [{ AbsEntry: 1 }], '@odata.nextLink': 'EnhancedDiscountGroups?$skip=100' },
      })
      .mockResolvedValueOnce({ data: { value: [{ AbsEntry: 2 }] } });

    await new SapDiscountClient().fetchActiveDiscountGroups({ sapConfig, tenantKey: 'tenant-1' });

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'SAP discount groups page retrieved',
      page: 1,
      pageCount: 1,
      totalSoFar: 1,
    }));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'SAP discount groups page retrieved',
      page: 2,
      pageCount: 1,
      totalSoFar: 2,
    }));
  });

  it('invalidates the session and retries once when the cookie is rejected', async () => {
    const unauthorized = new Error('unauthorized');
    unauthorized.response = { status: 401 };

    mockAxiosGet
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({ data: { value: [{ AbsEntry: 9 }] } });

    const result = await new SapDiscountClient().fetchActiveDiscountGroups({
      sapConfig,
      tenantKey: 'tenant-1',
    });

    expect(result).toEqual([{ AbsEntry: 9 }]);
    expect(mockInvalidateSession).toHaveBeenCalledWith('tenant-1');
    expect(mockGetSessionCookie).toHaveBeenCalledTimes(2);
  });
});
