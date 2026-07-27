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
    // Resolves the tenant SAP flavor so the HubSpot seed can create the
    // properties that only exist for one flavor. Injected to keep this
    // use case free of infrastructure imports.
    sapFlavorResolver = null,
    logger = console,
  }) {
    this.tenantRepository = tenantRepository;
    this.hubspotAuthProvider = hubspotAuthProvider;
    this.masterConfigReplicator = masterConfigReplicator;
    this.tenantHubspotSeeder = tenantHubspotSeeder;
    this.sapFlavorResolver = sapFlavorResolver;
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
        const sapFlavor = await this.sapFlavorResolver?.resolveSapFlavor({ tenantModels });
        await this.tenantHubspotSeeder.seed({ tenantConnection, credentials, sapFlavor });
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
