import { jest } from '@jest/globals';

const mockAxiosPost = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: {
    post: mockAxiosPost,
  },
}));

const hubspotAuthService = (await import('../../src/infrastructure/hubspot/hubspotAuthService.js')).default;

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

describe('hubspotAuthService.exchangeCodeForTokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildTenantModels(existing = null) {
    return {
      HubspotCredentials: {
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(async (doc) => ({ _id: 'cred-new', ...doc })),
      },
    };
  }

  function mockTokenResponse(hubId) {
    mockAxiosPost.mockResolvedValue({
      data: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 1800,
        hub_id: hubId,
      },
    });
  }

  it('stores the tokens when HubSpot authorized the expected portal', async () => {
    const tenantModels = buildTenantModels();
    mockTokenResponse(50082681);

    const credentials = await hubspotAuthService.exchangeCodeForTokens(
      'code-1',
      'cfg-1',
      tenantModels,
      { expectedPortalId: '50082681' }
    );

    expect(credentials.portalId).toBe(50082681);
    expect(tenantModels.HubspotCredentials.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to store tokens from a portal other than the tenant being installed', async () => {
    const existing = { accessToken: 'real-token', save: jest.fn() };
    const tenantModels = buildTenantModels(existing);
    mockTokenResponse(99999999);

    await expect(
      hubspotAuthService.exchangeCodeForTokens('code-1', 'cfg-1', tenantModels, {
        expectedPortalId: '50082681',
      })
    ).rejects.toMatchObject({ code: 'HUBSPOT_PORTAL_MISMATCH' });

    expect(existing.accessToken).toBe('real-token');
    expect(existing.save).not.toHaveBeenCalled();
    expect(tenantModels.HubspotCredentials.create).not.toHaveBeenCalled();
  });

  it('refuses to store tokens when no expected portal is given', async () => {
    const tenantModels = buildTenantModels();
    mockTokenResponse(50082681);

    await expect(
      hubspotAuthService.exchangeCodeForTokens('code-1', 'cfg-1', tenantModels)
    ).rejects.toMatchObject({ code: 'HUBSPOT_PORTAL_MISMATCH' });

    expect(tenantModels.HubspotCredentials.create).not.toHaveBeenCalled();
  });
});
