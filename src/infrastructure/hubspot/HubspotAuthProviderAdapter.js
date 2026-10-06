import hubspotAuthService from './hubspotAuthService.js';

export class HubspotAuthProviderAdapter {
  generateAuthUrl(clientConfigId, state) {
    return hubspotAuthService.generateAuthUrl(clientConfigId, state);
  }

  exchangeCodeForTokens(code, clientConfigId, tenantModels, options) {
    return hubspotAuthService.exchangeCodeForTokens(code, clientConfigId, tenantModels, options);
  }
}

export default HubspotAuthProviderAdapter;
