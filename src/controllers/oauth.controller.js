import hubspotAuthService from '../services/hubspotAuthService.js';

export const initOAuth = (req, reply) => {
  const { clientConfigId } = req.params;
  const url = hubspotAuthService.generateAuthUrl(clientConfigId);

  return reply.redirect(url);
};

export const oauthCallback = async (req, reply) => {
  const { code, state } = req.query;
  const clientConfigId = state;

  await hubspotAuthService.exchangeCodeForTokens(code, clientConfigId);

  return reply.send({ ok: true, message: 'HubSpot connected' });
};
