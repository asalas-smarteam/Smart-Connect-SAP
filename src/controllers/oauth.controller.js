import { SaaSClient } from '../config/database.js';
import { getTenantModels } from '../config/tenantDatabase.js';
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

export const initOAuthForTenant = async (req, reply) => {
  try {
    const { tenantId, portalId } = req.body || {};

    if (!tenantId || !portalId) {
      return reply.code(400).send({ ok: false, message: 'tenantId and portalId are required' });
    }

    const client = await SaaSClient.findById(tenantId);
    if (!client) {
      return reply.code(404).send({ ok: false, message: 'Tenant not found' });
    }

    const tenantModels = await getTenantModels(client.tenantKey);
    const { ClientConfig, HubspotCredentials } = tenantModels;

    let clientConfig = await ClientConfig.findOne();
    if (!clientConfig) {
      clientConfig = await ClientConfig.create({ clientName: client.companyName });
    }

    let credentials = await HubspotCredentials.findOne({ clientConfigId: clientConfig._id });
    if (!credentials) {
      credentials = await HubspotCredentials.create({
        clientConfigId: clientConfig._id,
        portalId,
      });
    } else if (credentials.portalId !== portalId) {
      credentials.portalId = portalId;
      await credentials.save();
    }

    if (!clientConfig.hubspotCredentialId
      || clientConfig.hubspotCredentialId.toString() !== credentials._id.toString()) {
      clientConfig.hubspotCredentialId = credentials._id;
      await clientConfig.save();
    }

    client.hubspot = {
      ...client.hubspot,
      portalId,
    };
    await client.save();

    const oauthUrl = hubspotAuthService.generateAuthUrl(clientConfig._id.toString());

    return reply.send({ ok: true, oauthUrl });
  } catch (error) {
    return reply.code(500).send({ ok: false, message: error.message });
  }
};
