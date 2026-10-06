import { oauthReasons } from '#application/use-cases/HandleHubspotOAuthCallback.js';
import { initHubspotOAuthReasons } from '#application/use-cases/InitHubspotOAuthForTenant.js';
import {
  buildInitHubspotOAuthForTenantUseCase,
  buildOAuthCallbackUseCase,
} from '#composition/oauth.composition.js';

function callbackStatusFor(reason) {
  if (reason === oauthReasons.BAD_REQUEST) {
    return 400;
  }

  if (reason === oauthReasons.PORTAL_MISMATCH) {
    return 403;
  }

  return 500;
}

export const oauthCallback = async (req, reply) => {
  const useCase = buildOAuthCallbackUseCase();
  const result = await useCase.execute({
    code: req.query?.code,
    state: req.query?.state,
  });

  if (!result.ok) {
    return reply.code(callbackStatusFor(result.reason)).send({ ok: false, message: result.message });
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
