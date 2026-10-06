import { parseOAuthState } from '../services/oauth-state.service.js';

const oauthReasons = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  PORTAL_MISMATCH: 'PORTAL_MISMATCH',
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
    // Secret con el que InitHubspotOAuthForTenant firmó el state. Sin él ningún state valida.
    stateSecret,
  }) {
    this.tenantRepository = tenantRepository;
    this.hubspotAuthProvider = hubspotAuthProvider;
    this.masterConfigReplicator = masterConfigReplicator;
    this.tenantHubspotSeeder = tenantHubspotSeeder;
    this.sapFlavorResolver = sapFlavorResolver;
    this.logger = logger;
    this.stateSecret = stateSecret;
  }

  async execute({ code, state }) {
    if (!code || !state) {
      return {
        ok: false,
        reason: oauthReasons.BAD_REQUEST,
        message: 'code and state are required',
      };
    }

    // El state firmado es la única fuente del tenant: el callback es público (HubSpot redirige
    // el navegador sin headers propios), así que nada del request puede elegir el destino.
    const parsedState = parseOAuthState(state, { secret: this.stateSecret });
    const { clientConfigId, tenantKey, portalId } = parsedState || {};
    if (!clientConfigId || !tenantKey || !portalId) {
      return {
        ok: false,
        reason: oauthReasons.BAD_REQUEST,
        message: 'Invalid or expired OAuth state',
      };
    }

    const tenantModels = await this.tenantRepository.getTenantModels(tenantKey);

    let credentials;
    try {
      credentials = await this.hubspotAuthProvider.exchangeCodeForTokens(
        code,
        clientConfigId,
        tenantModels,
        { expectedPortalId: portalId }
      );
    } catch (error) {
      if (error?.code === 'HUBSPOT_PORTAL_MISMATCH') {
        this.logger.error?.({
          msg: 'OAuth callback rejected: HubSpot authorized a different portal',
          tenantKey,
          expectedPortalId: portalId,
        });
        return {
          ok: false,
          reason: oauthReasons.PORTAL_MISMATCH,
          message: 'The HubSpot portal does not match the tenant being installed',
        };
      }
      throw error;
    }

    if (credentials?._id && credentials?.accessToken) {
      await this.masterConfigReplicator.replicate({
        tenantModels,
        hubspotCredentialId: credentials._id,
      });

      try {
        const tenantConnection = await this.tenantRepository.getTenantConnection(tenantKey);
        const sapFlavor = await this.sapFlavorResolver?.resolveSapFlavor({ tenantModels });
        await this.tenantHubspotSeeder.seed({ tenantConnection, credentials, sapFlavor });
      } catch (seedError) {
        this.logger.error?.({
          msg: 'HubSpot tenant seed failed after OAuth callback',
          tenantKey,
          hubspotCredentialId: credentials._id.toString(),
          error: seedError.message,
          details: seedError.details ?? null,
        });
      }
    }

    return {
      ok: true,
      data: { message: 'HubSpot connected' },
      meta: { tenantModels, tenantKey },
    };
  }
}

export { oauthReasons };

export default HandleHubspotOAuthCallback;
