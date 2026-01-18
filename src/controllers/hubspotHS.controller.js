import hubspotAuthService from '../services/hubspotAuthService.js';
import * as hubspotClient from '../services/hubspotClient.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export const refreshAccessToken = async (req, reply) => {
  const { clientConfigId } = req.params;
  const tenantModels = requireTenantModels(req);

  const accessToken = await hubspotAuthService.refreshAccessToken(clientConfigId, tenantModels);

  return reply.send({ accessToken });
};

export const testCreateContact = async (req, reply) => {
  const { id: clientConfigId } = req.params;
  const properties = req.body;
  const tenantModels = requireTenantModels(req);

  const token = await hubspotAuthService.getAccessToken(clientConfigId, tenantModels);
  const data = await hubspotClient.createContact(token, { properties });

  return reply.send({ ok: true, data });
};
