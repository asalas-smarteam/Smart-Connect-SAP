import hubspotAuthService from '../services/hubspotAuthService.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export const initOAuth = (req, reply) => {
  const { clientConfigId } = req.params;
  const url = hubspotAuthService.generateAuthUrl(clientConfigId);

  return reply.redirect(url);
};

export const oauthCallback = async (req, reply) => {
  const { code, state } = req.query;
  const clientConfigId = state;
  const tenantModels = requireTenantModels(req);

  await hubspotAuthService.exchangeCodeForTokens(code, clientConfigId, tenantModels);

  return reply.send({ ok: true, message: 'HubSpot connected' });
};
