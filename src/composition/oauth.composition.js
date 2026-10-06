import HandleHubspotOAuthCallback from '#application/use-cases/HandleHubspotOAuthCallback.js';
import InitHubspotOAuthForTenant from '#application/use-cases/InitHubspotOAuthForTenant.js';
import OAuthTenantRepository from '#infrastructure/database/repositories/OAuthTenantRepository.js';
import HubspotAuthProviderAdapter from '#infrastructure/hubspot/HubspotAuthProviderAdapter.js';
import {
  MasterConfigReplicatorAdapter,
  TenantHubspotSeederAdapter,
} from '#infrastructure/hubspot/TenantHubspotSeederAdapter.js';
import SapFlavorConfigRepository from '#infrastructure/config/SapFlavorConfigRepository.js';
import logger from '#infrastructure/logger/logger.js';

export function buildHubspotAuthProvider() {
  return new HubspotAuthProviderAdapter();
}

// El state de OAuth se firma con el client secret de la app: ya es obligatorio para el
// intercambio de tokens, así que donde OAuth funciona este secret existe sin configurar nada
// nuevo. Se lee en cada build para respetar cambios de entorno igual que hubspotAuthService.
function oauthStateSecret() {
  return process.env.HUBSPOT_CLIENT_SECRET;
}

export function buildOAuthCallbackUseCase() {
  return new HandleHubspotOAuthCallback({
    tenantRepository: new OAuthTenantRepository(),
    hubspotAuthProvider: buildHubspotAuthProvider(),
    masterConfigReplicator: new MasterConfigReplicatorAdapter(),
    tenantHubspotSeeder: new TenantHubspotSeederAdapter(),
    sapFlavorResolver: new SapFlavorConfigRepository(),
    logger,
    stateSecret: oauthStateSecret(),
  });
}

export function buildInitHubspotOAuthForTenantUseCase() {
  return new InitHubspotOAuthForTenant({
    tenantRepository: new OAuthTenantRepository(),
    hubspotAuthProvider: buildHubspotAuthProvider(),
    stateSecret: oauthStateSecret(),
  });
}
