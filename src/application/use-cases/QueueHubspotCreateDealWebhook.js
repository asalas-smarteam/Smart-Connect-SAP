import { ApplicationError } from '../../shared/errors/index.js';

function validationError(message) {
  return new ApplicationError(message, {
    code: 'INVALID_HUBSPOT_WEBHOOK_PAYLOAD',
    statusCode: 400,
  });
}

function validatePayload(payload) {
  if (!payload?.portalId) {
    throw validationError('portalId is required');
  }

  if (!payload?.deal) {
    throw validationError('deal is required');
  }

  if (!payload?.deal?.hs_object_id) {
    throw validationError('deal.hs_object_id is required');
  }
}

export class QueueHubspotCreateDealWebhook {
  constructor({
    activeTenantResolver,
    webhookEventRepository,
    webhookQueue,
    logger,
  }) {
    this.activeTenantResolver = activeTenantResolver;
    this.webhookEventRepository = webhookEventRepository;
    this.webhookQueue = webhookQueue;
    this.logger = logger;
  }

  async execute({ payload = {}, tenantId }) {
    validatePayload(payload);

    const resolvedTenantId = tenantId || payload.tenantId;
    if (!resolvedTenantId) {
      throw validationError('tenantId is required');
    }

    this.logger.info({
      msg: 'HubSpot createDeal webhook received',
      tenantId: resolvedTenantId,
      portalId: payload.portalId,
      dealId: payload?.deal?.hs_object_id,
    });

    const tenantContext = await this.activeTenantResolver.resolve({
      tenantId: resolvedTenantId,
    });

    if (!tenantContext) {
      throw new ApplicationError('Tenant not found or inactive', {
        code: 'TENANT_NOT_ACTIVE',
        statusCode: 404,
      });
    }

    const tenantPortalId = tenantContext.client?.hubspot?.portalId;
    if (tenantPortalId && tenantPortalId !== payload.portalId) {
      throw validationError('portalId does not match tenant');
    }

    const queueResult = await this.webhookEventRepository.queueCreateDealEvent({
      tenantKey: tenantContext.client.tenantKey,
      payload,
    });

    if (queueResult.duplicated) {
      this.logger.info({
        msg: 'Duplicate HubSpot createDeal webhook detected',
        tenantId: resolvedTenantId,
        portalId: payload.portalId,
        dealId: payload.deal.hs_object_id,
        webhookEventId: queueResult.eventId,
      });

      return {
        duplicated: true,
        message: 'Duplicate event ignored',
      };
    }

    await this.webhookQueue.addManualJob({
      tenantId: tenantContext.client._id,
      tenantKey: tenantContext.client.tenantKey,
      portalId: tenantPortalId || payload.portalId,
      triggerType: 'webhook',
    });

    this.logger.info({
      msg: 'HubSpot createDeal webhook event queued',
      tenantId: resolvedTenantId,
      portalId: payload.portalId,
      dealId: payload.deal.hs_object_id,
      webhookEventId: queueResult.eventId,
    });

    return {
      duplicated: false,
      message: 'Event queued',
    };
  }
}

export default QueueHubspotCreateDealWebhook;
