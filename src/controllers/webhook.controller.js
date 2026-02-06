import { getTenantModels } from '../config/tenantDatabase.js';
import { listActiveTenants, resolveActiveTenant } from '../utils/tenantSubscriptions.js';

function resolveObjectType(req) {
  return (
    req.body?.objectType
    || req.query?.objectType
    || req.headers?.['x-object-type']
    || 'deal'
  ).toString().toLowerCase();
}

function resolveHubspotCredentialId(req) {
  return (
    req.body?.hubspotCredentialId
    || req.query?.hubspotCredentialId
    || req.headers?.['x-hubspot-credential-id']
  );
}

async function resolveTenantContext({ hubspotCredentialId, portalId, tenantKey, tenantId }) {
  const directTenant = await resolveActiveTenant({ tenantKey, tenantId, portalId });
  if (directTenant) {
    return directTenant;
  }

  if (!hubspotCredentialId) {
    return null;
  }

  const activeTenants = await listActiveTenants();

  for (const { client, subscription } of activeTenants) {
    const tenantModels = await getTenantModels(client.tenantKey);
    const credential = await tenantModels.HubspotCredentials.findById(hubspotCredentialId);
    if (credential) {
      return { client, subscription };
    }
  }

  return null;
}

export const receiveHubspotWebhook = async (req, reply) => {
  try {
    const hubspotCredentialId = resolveHubspotCredentialId(req);
    const objectType = resolveObjectType(req);
    const portalId = req.body?.portalId || req.query?.portalId || req.headers?.['x-hubspot-portal-id'];
    const tenantKey = req.body?.tenantKey || req.query?.tenantKey || req.headers?.['x-tenant-key'];
    const tenantId = req.body?.tenantId || req.query?.tenantId || req.headers?.['x-tenant-id'];

    const tenantContext = await resolveTenantContext({
      hubspotCredentialId,
      portalId,
      tenantKey,
      tenantId,
    });

    if (!tenantContext) {
      return reply.code(200).send({ ok: true, message: 'Tenant not found' });
    }

    const tenantModels = await getTenantModels(tenantContext.client.tenantKey);
    const { WebhookConfig, WebhookEvent, HubspotCredentials } = tenantModels;

    let resolvedCredentialId = hubspotCredentialId;

    if (!resolvedCredentialId && portalId) {
      const credential = await HubspotCredentials.findOne({ portalId });
      resolvedCredentialId = credential?._id;
    }

    if (!resolvedCredentialId) {
      return reply.code(200).send({ ok: true, message: 'Missing HubSpot credential' });
    }

    const config = await WebhookConfig.findOne({
      hubspotCredentialId: resolvedCredentialId,
      enabled: true,
      enabledObjectTypes: { $in: [objectType] },
    });

    if (!config) {
      return reply.code(200).send({ ok: true, message: 'Webhook disabled' });
    }

    await WebhookEvent.create({
      hubspotCredentialId: resolvedCredentialId,
      objectType,
      payload: req.body,
      status: 'pending',
    });

    return reply.code(200).send({ ok: true });
  } catch (error) {
    return reply.code(200).send({ ok: true, error: error.message });
  }
};
