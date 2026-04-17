import { getTenantModels } from '../config/tenantDatabase.js';
import logger from '../core/logger.js';
import { addWebhookTenantJob } from '../queues/webhook.queue.js';
import { queueCreateDealEvent } from '../services/webhookEvent.service.js';
import { resolveActiveTenant } from '../utils/tenantSubscriptions.js';

function validatePayload(body) {

  if (!body?.portalId) {
    return 'portalId is required';
  }

  if (!body?.deal) {
    return 'deal is required';
  }

  if (!body?.deal?.hs_object_id) {
    return 'deal.hs_object_id is required';
  }

  return null;
}

export const receiveHubspotWebhook = async (req, reply) => {
  try {
    const body = req.body ?? {};
    const validationError = validatePayload(body);
    const tenantId = req.headers?.['x-tenant-id'] || body.tenantId;

    logger.info({
      msg: 'HubSpot createDeal webhook received',
      tenantId: body.tenantId,
      portalId: body.portalId,
      dealId: body?.deal?.hs_object_id,
    });

    if (validationError) {
      return reply.code(400).send({ success: false, message: validationError });
    }

    if (!tenantId) {
      return reply.code(400).send({ success: false, message: 'tenantId is required' });
    }

    const tenantContext = await resolveActiveTenant({
      tenantId,
    });

    if (!tenantContext) {
      return reply.code(404).send({ success: false, message: 'Tenant not found or inactive' });
    }

    const tenantPortalId = tenantContext.client?.hubspot?.portalId;
    if (tenantPortalId && tenantPortalId !== body.portalId) {
      return reply.code(400).send({ success: false, message: 'portalId does not match tenant' });
    }

    const tenantModels = await getTenantModels(tenantContext.client.tenantKey);
    const { WebhookEvent } = tenantModels;
    const queueResult = await queueCreateDealEvent({ WebhookEvent, payload: body });

    if (queueResult.duplicated) {
      logger.info({
        msg: 'Duplicate HubSpot createDeal webhook detected',
        tenantId: body.tenantId,
        portalId: body.portalId,
        dealId: body.deal.hs_object_id,
        webhookEventId: queueResult.eventId,
      });

      return reply.code(200).send({
        success: true,
        message: 'Duplicate event ignored',
      });
    }

    await addWebhookTenantJob({
      tenantId: tenantContext.client._id,
      tenantKey: tenantContext.client.tenantKey,
      portalId: tenantPortalId || body.portalId,
      triggerType: 'webhook',
    });

    logger.info({
      msg: 'HubSpot createDeal webhook event queued',
      tenantId,
      portalId: body.portalId,
      dealId: body.deal.hs_object_id,
      webhookEventId: queueResult.eventId,
    });

    return reply.code(200).send({
      success: true,
      message: 'Event queued',
    });
  } catch (error) {
    logger.error({
      msg: 'Failed to queue HubSpot createDeal webhook',
      error: error.message,
    });
    return reply.code(500).send({ success: false, message: 'Internal error' });
  }
};
