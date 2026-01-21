import { SaaSClient } from '../config/database.js';
import { getTenantModels } from '../config/tenantDatabase.js';
import hubspotAuthService from '../services/hubspotAuthService.js';
import { requireTenantModels } from '../utils/tenantModels.js';

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function buildOAuthState(payload) {
  const json = JSON.stringify(payload);
  return base64UrlEncode(Buffer.from(json, 'utf8'));
}

function parseOAuthState(state) {
  if (!state) {
    return { clientConfigId: null, tenantKey: null };
  }

  try {
    const json = base64UrlDecode(state);
    const parsed = JSON.parse(json);
    return {
      clientConfigId: parsed?.clientConfigId || null,
      tenantKey: parsed?.tenantKey || null,
    };
  } catch (error) {
    return { clientConfigId: state, tenantKey: null };
  }
}

export const initOAuth = (req, reply) => {
  const { clientConfigId } = req.params;
  const state = req.tenantKey
    ? buildOAuthState({ clientConfigId, tenantKey: req.tenantKey })
    : clientConfigId;
  const url = hubspotAuthService.generateAuthUrl(clientConfigId, state);

  return reply.redirect(url);
};

export const oauthCallback = async (req, reply) => {
  const { code, state } = req.query;
  const { clientConfigId, tenantKey } = parseOAuthState(state);

  if (!code || !clientConfigId) {
    return reply.code(400).send({ ok: false, message: 'code and state are required' });
  }

  let tenantModels = req.tenantModels;
  if (!tenantModels) {
    if (!tenantKey) {
      return reply.code(400).send({ ok: false, message: 'tenantKey is required in state' });
    }
    tenantModels = await getTenantModels(tenantKey);
    req.tenantModels = tenantModels;
    req.tenantKey = tenantKey;
  } else {
    tenantModels = requireTenantModels(req);
  }

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

    const clientConfig = await ClientConfig.findOne();
    if (!clientConfig) {
      return reply.code(400).send({
        ok: false,
        message: 'ClientConfig is required before initiating OAuth',
      });
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

    const state = buildOAuthState({
      clientConfigId: clientConfig._id.toString(),
      tenantKey: client.tenantKey,
    });
    const oauthUrl = hubspotAuthService.generateAuthUrl(clientConfig._id.toString(), state);

    return reply.send({ ok: true, oauthUrl });
  } catch (error) {
    return reply.code(500).send({ ok: false, message: error.message });
  }
};
