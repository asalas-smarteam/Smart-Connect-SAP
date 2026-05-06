import { ApplicationError } from '../../shared/errors/index.js';
import HubspotCreateDealWebhook from '../../domain/webhooks/HubspotCreateDealWebhook.js';

function validationError(message) {
  return new ApplicationError(message, {
    code: 'INVALID_HUBSPOT_WEBHOOK_PAYLOAD',
    statusCode: 400,
  });
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
    const webhook = HubspotCreateDealWebhook.fromRequest({ payload, tenantId });
    try {
      webhook.validate();
    } catch (error) {
      throw validationError(error.message);
    }

    this.logger.info({
      msg: 'HubSpot createDeal webhook received',
      tenantId: webhook.tenantId,
      portalId: webhook.portalId,
      dealId: webhook.dealId,
    });

    const tenantContext = await this.activeTenantResolver.resolve({
      tenantId: webhook.tenantId,
    });

    if (!tenantContext) {
      throw new ApplicationError('Tenant not found or inactive', {
        code: 'TENANT_NOT_ACTIVE',
        statusCode: 404,
      });
    }

    const tenantPortalId = tenantContext.client?.hubspot?.portalId;
    try {
      webhook.assertMatchesTenantPortal(tenantPortalId);
    } catch (error) {
      throw validationError(error.message);
    }

    const queueResult = await this.webhookEventRepository.queueCreateDealEvent({
      tenantKey: tenantContext.client.tenantKey,
      payload,
    });

    if (queueResult.duplicated) {
      this.logger.info({
        msg: 'Duplicate HubSpot createDeal webhook detected',
        tenantId: webhook.tenantId,
        portalId: webhook.portalId,
        dealId: webhook.dealId,
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
      portalId: tenantPortalId || webhook.portalId,
      triggerType: 'webhook',
    });

    this.logger.info({
      msg: 'HubSpot createDeal webhook event queued',
      tenantId: webhook.tenantId,
      portalId: webhook.portalId,
      dealId: webhook.dealId,
      webhookEventId: queueResult.eventId,
    });

    return {
      duplicated: false,
      message: 'Event queued',
    };
  }
}

export default QueueHubspotCreateDealWebhook;
