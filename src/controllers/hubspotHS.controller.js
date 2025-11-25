import hubspotAuthService from '../services/hubspotAuthService.js';
import * as hubspotClient from '../services/hubspotClient.js';

export const refreshAccessToken = async (req, reply) => {
  const { clientConfigId } = req.params;

  const accessToken = await hubspotAuthService.refreshAccessToken(clientConfigId);

  return reply.send({ accessToken });
};

export const testCreateContact = async (req, reply) => {
  const { id: clientConfigId } = req.params;
  const properties = req.body;

  const token = await hubspotAuthService.getAccessToken(clientConfigId);
  const data = await hubspotClient.createContact(token, { properties });

  return reply.send({ ok: true, data });
};
