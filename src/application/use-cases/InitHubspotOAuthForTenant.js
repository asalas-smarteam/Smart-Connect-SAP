import { buildOAuthState } from '../services/oauth-state.service.js';

const initHubspotOAuthReasons = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
});

export class InitHubspotOAuthForTenant {
  constructor({ tenantRepository, hubspotAuthProvider }) {
    this.tenantRepository = tenantRepository;
    this.hubspotAuthProvider = hubspotAuthProvider;
  }

  async execute({ tenantId, portalId }) {
    if (!tenantId || !portalId) {
      return {
        ok: false,
        reason: initHubspotOAuthReasons.BAD_REQUEST,
        message: 'tenantId and portalId are required',
      };
    }

    const client = await this.tenantRepository.findClientById(tenantId);
    if (!client) {
      return {
        ok: false,
        reason: initHubspotOAuthReasons.NOT_FOUND,
        message: 'Tenant not found',
      };
    }

    const tenantModels = await this.tenantRepository.getTenantModels(client.tenantKey);
    const { clientConfig, credentials } = await this.tenantRepository.ensureHubspotCredential({
      tenantModels,
      client,
      portalId,
    });

    await this.tenantRepository.updateClientHubspotPortal({ client, portalId });

    const state = buildOAuthState({
      clientConfigId: clientConfig._id.toString(),
      tenantKey: client.tenantKey,
    });
    const oauthUrl = this.hubspotAuthProvider.generateAuthUrl(
      clientConfig._id.toString(),
      state
    );

    return { ok: true, data: { oauthUrl, credentials } };
  }
}

export { initHubspotOAuthReasons };

export default InitHubspotOAuthForTenant;
