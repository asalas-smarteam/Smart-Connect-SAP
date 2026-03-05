import { jest } from '@jest/globals';

const mockGetTenantModels = jest.fn();
const mockGetTenantConnection = jest.fn();
const mockExchangeCodeForTokens = jest.fn();
const mockSeedHubspotMappings = jest.fn();
const mockSeedCreateFieldsHubspot = jest.fn();
const mockRequireTenantModels = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule('../../src/config/database.js', () => ({
  SaaSClient: {},
}));

jest.unstable_mockModule('../../src/config/tenantDatabase.js', () => ({
  getTenantModels: mockGetTenantModels,
  getTenantConnection: mockGetTenantConnection,
}));

jest.unstable_mockModule('../../src/core/logger.js', () => ({
  default: {
    error: mockLoggerError,
  },
}));

jest.unstable_mockModule('../../src/services/hubspotAuthService.js', () => ({
  default: {
    exchangeCodeForTokens: mockExchangeCodeForTokens,
    generateAuthUrl: jest.fn(),
  },
}));

jest.unstable_mockModule('../../src/services/tenant/tenantHubspotSeed.service.js', () => ({
  seedHubspotMappings: mockSeedHubspotMappings,
  seedCreateFieldsHubspot: mockSeedCreateFieldsHubspot,
}));

jest.unstable_mockModule('../../src/utils/tenantModels.js', () => ({
  requireTenantModels: mockRequireTenantModels,
}));

const { oauthCallback } = await import('../../src/controllers/oauth.controller.js');

function buildState({ clientConfigId, tenantKey }) {
  return Buffer.from(JSON.stringify({ clientConfigId, tenantKey }), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

describe('oauth.controller oauthCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('seeds HubSpot mappings after token exchange', async () => {
    const tenantModels = { HubspotCredentials: {} };
    const tenantConnection = { id: 'tenant-connection' };
    const credentials = { _id: 'cred-1', accessToken: 'token-1' };
    const state = buildState({ clientConfigId: 'client-config-1', tenantKey: 'tenant_1' });

    mockGetTenantModels.mockResolvedValue(tenantModels);
    mockGetTenantConnection.mockResolvedValue(tenantConnection);
    mockExchangeCodeForTokens.mockResolvedValue(credentials);
    mockSeedHubspotMappings.mockResolvedValue({ pipelinesCount: 1, stagesCount: 1, ownersCount: 1 });
    mockSeedCreateFieldsHubspot.mockResolvedValue({ totalFields: 3, createdFields: 3, existingFields: 0 });

    const req = {
      query: {
        code: 'oauth-code-1',
        state,
      },
    };

    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn((payload) => payload),
    };

    await oauthCallback(req, reply);

    expect(mockGetTenantModels).toHaveBeenCalledWith('tenant_1');
    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith('oauth-code-1', 'client-config-1', tenantModels);
    expect(mockGetTenantConnection).toHaveBeenCalledWith('tenant_1');
    expect(mockSeedHubspotMappings).toHaveBeenCalledWith({
      tenantConnection,
      hubspotCredential: credentials,
    });
    expect(mockSeedCreateFieldsHubspot).toHaveBeenCalledWith({
      hubspotCredential: credentials,
    });
    expect(reply.send).toHaveBeenCalledWith({ ok: true, message: 'HubSpot connected' });
  });

  it('returns 400 when code or state are missing', async () => {
    const req = {
      query: {
        state: '',
      },
    };

    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn((payload) => payload),
    };

    await oauthCallback(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ ok: false, message: 'code and state are required' });
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
    expect(mockSeedHubspotMappings).not.toHaveBeenCalled();
    expect(mockSeedCreateFieldsHubspot).not.toHaveBeenCalled();
  });
});
