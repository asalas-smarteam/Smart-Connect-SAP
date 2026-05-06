import HandleHubspotOAuthCallback from '#application/use-cases/HandleHubspotOAuthCallback.js';
import InitHubspotOAuthForTenant from '#application/use-cases/InitHubspotOAuthForTenant.js';
import OAuthTenantRepository from '#infrastructure/database/repositories/OAuthTenantRepository.js';
import HubspotAuthProviderAdapter from '#infrastructure/hubspot/HubspotAuthProviderAdapter.js';
import {
  MasterConfigReplicatorAdapter,
  TenantHubspotSeederAdapter,
} from '#infrastructure/hubspot/TenantHubspotSeederAdapter.js';
import logger from '#infrastructure/logger/logger.js';

export function buildHubspotAuthProvider() {
  return new HubspotAuthProviderAdapter();
}

export function buildOAuthCallbackUseCase() {
  return new HandleHubspotOAuthCallback({
    tenantRepository: new OAuthTenantRepository(),
    hubspotAuthProvider: buildHubspotAuthProvider(),
    masterConfigReplicator: new MasterConfigReplicatorAdapter(),
    tenantHubspotSeeder: new TenantHubspotSeederAdapter(),
    logger,
  });
}

export function buildInitHubspotOAuthForTenantUseCase() {
  return new InitHubspotOAuthForTenant({
    tenantRepository: new OAuthTenantRepository(),
    hubspotAuthProvider: buildHubspotAuthProvider(),
  });
}
