import { jest } from '@jest/globals';
import HandleHubspotOAuthCallback, {
  oauthReasons,
} from '../../../src/application/use-cases/HandleHubspotOAuthCallback.js';
import InitHubspotOAuthForTenant from '../../../src/application/use-cases/InitHubspotOAuthForTenant.js';
import { buildOAuthState, parseOAuthState } from '../../../src/application/services/oauth-state.service.js';

const SECRET = 'state-secret-test';

function portalMismatchError() {
  const error = new Error('HubSpot authorized a different portal');
  error.code = 'HUBSPOT_PORTAL_MISMATCH';
  return error;
}

describe('InitHubspotOAuthForTenant', () => {
  it('signs the install portal into the OAuth state', async () => {
    const client = { _id: 'tenant-1', tenantKey: 'printer' };
    const tenantRepository = {
      findClientById: jest.fn().mockResolvedValue(client),
      getTenantModels: jest.fn().mockResolvedValue({}),
      ensureHubspotCredential: jest.fn().mockResolvedValue({
        clientConfig: { _id: 'cfg-1' },
        credentials: {},
      }),
      updateClientHubspotPortal: jest.fn(),
    };
    const hubspotAuthProvider = {
      generateAuthUrl: jest.fn((clientConfigId, state) => `https://hubspot.test/oauth?state=${state}`),
    };
    const useCase = new InitHubspotOAuthForTenant({
      tenantRepository,
      hubspotAuthProvider,
      stateSecret: SECRET,
    });

    const result = await useCase.execute({ tenantId: 'tenant-1', portalId: '50082681' });

    expect(result.ok).toBe(true);
    const [, state] = hubspotAuthProvider.generateAuthUrl.mock.calls[0];
    expect(parseOAuthState(state, { secret: SECRET })).toEqual({
      clientConfigId: 'cfg-1',
      tenantKey: 'printer',
      portalId: '50082681',
    });
  });
});

describe('HandleHubspotOAuthCallback', () => {
  function buildUseCase({ exchange = jest.fn().mockResolvedValue({ _id: 'cred-1', accessToken: 'a' }) } = {}) {
    const tenantRepository = {
      getTenantModels: jest.fn().mockResolvedValue({ HubspotCredentials: {} }),
      getTenantConnection: jest.fn().mockResolvedValue({}),
    };
    const hubspotAuthProvider = { exchangeCodeForTokens: exchange };
    const useCase = new HandleHubspotOAuthCallback({
      tenantRepository,
      hubspotAuthProvider,
      masterConfigReplicator: { replicate: jest.fn() },
      tenantHubspotSeeder: { seed: jest.fn() },
      logger: { error: jest.fn() },
      stateSecret: SECRET,
    });
    return { useCase, tenantRepository, exchange };
  }

  function signedState(overrides = {}) {
    return buildOAuthState(
      { clientConfigId: 'cfg-1', tenantKey: 'printer', portalId: '50082681', ...overrides },
      { secret: SECRET }
    );
  }

  it('rejects an unsigned state without touching any tenant', async () => {
    const { useCase, tenantRepository, exchange } = buildUseCase();
    const unsigned = Buffer.from(JSON.stringify({ clientConfigId: 'cfg-1', tenantKey: 'printer' }))
      .toString('base64url');

    const result = await useCase.execute({ code: 'code-1', state: unsigned });

    expect(result).toMatchObject({ ok: false, reason: oauthReasons.BAD_REQUEST });
    expect(tenantRepository.getTenantModels).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it('asks the token exchange to enforce the portal signed into the state', async () => {
    const { useCase, exchange } = buildUseCase();

    const result = await useCase.execute({ code: 'code-1', state: signedState() });

    expect(result.ok).toBe(true);
    expect(exchange).toHaveBeenCalledWith('code-1', 'cfg-1', { HubspotCredentials: {} }, {
      expectedPortalId: '50082681',
    });
  });

  it('reports a portal mismatch as its own reason and skips the seed', async () => {
    const { useCase } = buildUseCase({ exchange: jest.fn().mockRejectedValue(portalMismatchError()) });

    const result = await useCase.execute({ code: 'code-1', state: signedState() });

    expect(result).toMatchObject({ ok: false, reason: oauthReasons.PORTAL_MISMATCH });
  });
});
