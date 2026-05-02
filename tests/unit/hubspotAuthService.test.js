import { jest } from '@jest/globals';

const mockAxiosPost = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: {
    post: mockAxiosPost,
  },
}));

const hubspotAuthService = (await import('../../src/services/hubspotAuthService.js')).default;

describe('hubspotAuthService.getAccessToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refreshes expired credentials and keeps the in-memory document updated', async () => {
    const credentials = {
      _id: 'cred-1',
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      save: jest.fn().mockResolvedValue(undefined),
    };

    const tenantModels = {
      HubspotCredentials: {
        findOne: jest.fn().mockResolvedValue(credentials),
      },
    };

    mockAxiosPost.mockResolvedValue({
      data: {
        access_token: 'fresh-token',
        refresh_token: 'fresh-refresh-token',
        expires_in: 1800,
      },
    });

    const token = await hubspotAuthService.getAccessToken(
      'cred-1',
      credentials,
      tenantModels
    );

    expect(token).toBe('fresh-token');
    expect(credentials.accessToken).toBe('fresh-token');
    expect(credentials.refreshToken).toBe('fresh-refresh-token');
    expect(credentials.expiresAt).toBeInstanceOf(Date);
    expect(credentials.save).toHaveBeenCalledTimes(1);
    expect(tenantModels.HubspotCredentials.findOne).toHaveBeenCalledWith({
      $or: [
        { clientConfigId: 'cred-1' },
        { _id: 'cred-1' },
      ],
    });
  });
});
