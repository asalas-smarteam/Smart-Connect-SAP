import { jest } from '@jest/globals';

const mockAxiosPost = jest.fn();
const redis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
};

jest.unstable_mockModule('axios', () => ({
  default: { post: mockAxiosPost },
}));

jest.unstable_mockModule('../../../src/infrastructure/cache/redisClient.js', () => ({
  getRedisClient: async () => redis,
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { default: sapSessionManager } = await import(
  '../../../src/infrastructure/sap/sapSessionManager.js'
);

const baseConfig = {
  tenantId: 'tenant-gw',
  serviceLayerBaseUrl: 'https://sl.example.com/',
  serviceLayerUsername: 'manager',
  serviceLayerPassword: 'secret',
};

describe('sapSessionManager Login gateway token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
    mockAxiosPost.mockResolvedValue({
      headers: { 'set-cookie': ['B1SESSION=abc; path=/'] },
      data: { SessionTimeout: 30 },
    });
  });

  it('sends Authorization on the Login POST when the token is set', async () => {
    const result = await sapSessionManager.getSessionCookie({
      ...baseConfig,
      serviceLayerGatewayToken: 'test-gateway-token',
    });

    expect(result.cookie).toBe('B1SESSION=abc');
    const [url, body, options] = mockAxiosPost.mock.calls[0];
    expect(url).toBe('https://sl.example.com/b1s/v2/Login');
    expect(body).toEqual({ UserName: 'manager', Password: 'secret' });
    expect(options.headers).toEqual({ Authorization: 'Bearer test-gateway-token' });
  });

  it('does not send any Authorization header when the token is absent', async () => {
    await sapSessionManager.getSessionCookie(baseConfig);

    const options = mockAxiosPost.mock.calls[0][2];
    expect(options.headers?.Authorization).toBeUndefined();
    expect(Object.keys(options.headers || {})).toHaveLength(0);
  });

  it('does not send Authorization when the token is blank', async () => {
    await sapSessionManager.getSessionCookie({ ...baseConfig, serviceLayerGatewayToken: '   ' });

    const options = mockAxiosPost.mock.calls[0][2];
    expect(options.headers?.Authorization).toBeUndefined();
  });

  it('never stores the token in the cached session payload', async () => {
    await sapSessionManager.getSessionCookie({
      ...baseConfig,
      serviceLayerGatewayToken: 'test-gateway-token',
    });

    const stored = redis.set.mock.calls.find(([key]) => String(key).startsWith('sap:session:'));
    expect(stored[1]).not.toContain('test-gateway-token');
  });
});
