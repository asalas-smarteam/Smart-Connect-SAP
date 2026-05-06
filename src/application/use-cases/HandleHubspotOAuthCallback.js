import { parseOAuthState } from '../services/oauth-state.service.js';

const oauthReasons = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
});

export class HandleHubspotOAuthCallback {
  constructor({
    tenantRepository,
    hubspotAuthProvider,
    masterConfigReplicator,
    tenantHubspotSeeder,
    logger = console,
  }) {
    this.tenantRepository = tenantRepository;
    this.hubspotAuthProvider = hubspotAuthProvider;
    this.masterConfigReplicator = masterConfigReplicator;
    this.tenantHubspotSeeder = tenantHubspotSeeder;
    this.logger = logger;
  }

  async execute({ code, state, requestTenantModels, requestTenantKey }) {
    const { clientConfigId, tenantKey } = parseOAuthState(state);

    if (!code || !clientConfigId) {
      return {
        ok: false,
        reason: oauthReasons.BAD_REQUEST,
        message: 'code and state are required',
      };
    }

    let tenantModels = requestTenantModels;
    if (!tenantModels) {
      if (!tenantKey) {
        return {
          ok: false,
          reason: oauthReasons.BAD_REQUEST,
          message: 'tenantKey is required in state',
        };
      }

      tenantModels = await this.tenantRepository.getTenantModels(tenantKey);
    }

    const credentials = await this.hubspotAuthProvider.exchangeCodeForTokens(
      code,
      clientConfigId,
      tenantModels
    );

    const resolvedTenantKey = requestTenantKey || tenantKey;
    if (resolvedTenantKey && credentials?._id && credentials?.accessToken) {
      await this.masterConfigReplicator.replicate({
        tenantModels,
        hubspotCredentialId: credentials._id,
      });

      try {
        const tenantConnection = await this.tenantRepository.getTenantConnection(resolvedTenantKey);
        await this.tenantHubspotSeeder.seed({ tenantConnection, credentials });
      } catch (seedError) {
        this.logger.error?.({
          msg: 'HubSpot tenant seed failed after OAuth callback',
          tenantKey: resolvedTenantKey,
          hubspotCredentialId: credentials._id.toString(),
          error: seedError.message,
          details: seedError.details ?? null,
        });
      }
    }

    return {
      ok: true,
      data: { message: 'HubSpot connected' },
      meta: { tenantModels, tenantKey: resolvedTenantKey },
    };
  }
}

export { oauthReasons };

export default HandleHubspotOAuthCallback;
