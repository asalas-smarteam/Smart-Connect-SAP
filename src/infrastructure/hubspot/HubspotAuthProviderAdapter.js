import hubspotAuthService from './hubspotAuthService.js';

export class HubspotAuthProviderAdapter {
  generateAuthUrl(clientConfigId, state) {
    return hubspotAuthService.generateAuthUrl(clientConfigId, state);
  }

  exchangeCodeForTokens(code, clientConfigId, tenantModels) {
    return hubspotAuthService.exchangeCodeForTokens(code, clientConfigId, tenantModels);
  }
}

export default HubspotAuthProviderAdapter;
