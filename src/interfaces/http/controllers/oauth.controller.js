import { buildOAuthState } from '../../../application/services/oauth-state.service.js';
import HandleHubspotOAuthCallback, {
  oauthReasons,
} from '../../../application/use-cases/HandleHubspotOAuthCallback.js';
import InitHubspotOAuthForTenant, {
  initHubspotOAuthReasons,
} from '../../../application/use-cases/InitHubspotOAuthForTenant.js';
import logger from '../../../infrastructure/logger/logger.js';
import OAuthTenantRepository from '../../../infrastructure/database/repositories/OAuthTenantRepository.js';
import HubspotAuthProviderAdapter from '../../../infrastructure/hubspot/HubspotAuthProviderAdapter.js';
import {
  MasterConfigReplicatorAdapter,
  TenantHubspotSeederAdapter,
} from '../../../infrastructure/hubspot/TenantHubspotSeederAdapter.js';
import requestTenantModelsAdapter from '../../../infrastructure/tenants/RequestTenantModelsAdapter.js';

function buildHubspotAuthProvider() {
  return new HubspotAuthProviderAdapter();
}

function buildOAuthCallbackUseCase() {
  return new HandleHubspotOAuthCallback({
    tenantRepository: new OAuthTenantRepository(),
    hubspotAuthProvider: buildHubspotAuthProvider(),
    masterConfigReplicator: new MasterConfigReplicatorAdapter(),
    tenantHubspotSeeder: new TenantHubspotSeederAdapter(),
    logger,
  });
}

function buildInitHubspotOAuthForTenantUseCase() {
  return new InitHubspotOAuthForTenant({
    tenantRepository: new OAuthTenantRepository(),
    hubspotAuthProvider: buildHubspotAuthProvider(),
  });
}

export const initOAuth = (req, reply) => {
  const { clientConfigId } = req.params;
  const state = req.tenantKey
    ? buildOAuthState({ clientConfigId, tenantKey: req.tenantKey })
    : clientConfigId;
  const url = buildHubspotAuthProvider().generateAuthUrl(clientConfigId, state);

  return reply.redirect(url);
};

export const oauthCallback = async (req, reply) => {
  const useCase = buildOAuthCallbackUseCase();
  const requestTenantModels = req.tenantModels ? requestTenantModelsAdapter.resolve(req) : null;
  const result = await useCase.execute({
    code: req.query?.code,
    state: req.query?.state,
    requestTenantModels,
    requestTenantKey: req.tenantKey,
  });

  if (!result.ok) {
    const status = result.reason === oauthReasons.BAD_REQUEST ? 400 : 500;
    return reply.code(status).send({ ok: false, message: result.message });
  }

  if (result.meta?.tenantModels) {
    req.tenantModels = result.meta.tenantModels;
  }
  if (result.meta?.tenantKey) {
    req.tenantKey = result.meta.tenantKey;
  }

  return reply.send({ ok: true, message: result.data.message });
};

export const initOAuthForTenant = async (req, reply) => {
  try {
    const useCase = buildInitHubspotOAuthForTenantUseCase();
    const result = await useCase.execute({
      tenantId: req.body?.tenantId,
      portalId: req.body?.portalId,
    });

    if (!result.ok) {
      const status = result.reason === initHubspotOAuthReasons.NOT_FOUND ? 404 : 400;
      return reply.code(status).send({ ok: false, message: result.message });
    }

    return reply.send({ ok: true, oauthUrl: result.data.oauthUrl });
  } catch (error) {
    return reply.code(500).send({ ok: false, message: error.message });
  }
};
