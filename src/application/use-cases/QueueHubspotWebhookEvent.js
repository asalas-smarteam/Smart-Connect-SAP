import { ApplicationError } from '#shared/errors/index.js';
import { HubspotDealWebhook } from '#domain/webhooks/HubspotCreateDealWebhook.js';

function validationError(message) {
  return new ApplicationError(message, {
    code: 'INVALID_HUBSPOT_WEBHOOK_PAYLOAD',
    statusCode: 400,
  });
}

// Generic queue use case shared by every deal-based HubSpot webhook. The concrete
// flow is selected via `eventType` (createDeal | createQuotation | updateQuotation |
// convertQuotationToOrder). It validates the base payload, resolves the active tenant,
// stores a WebhookEvent and enqueues the per-tenant BullMQ job.
export class QueueHubspotWebhookEvent {
  constructor({
    activeTenantResolver,
    webhookEventRepository,
    webhookQueue,
    logger,
    eventType = 'createDeal',
  }) {
    this.activeTenantResolver = activeTenantResolver;
    this.webhookEventRepository = webhookEventRepository;
    this.webhookQueue = webhookQueue;
    this.logger = logger;
    this.eventType = eventType;
  }

  async execute({ payload = {}, tenantId }) {
    const webhook = HubspotDealWebhook.fromRequest({
      payload,
      tenantId,
      eventType: this.eventType,
    });
    try {
      webhook.validate();
    } catch (error) {
      throw validationError(error.message);
    }

    this.logger.info({
      msg: 'HubSpot webhook received',
      eventType: this.eventType,
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

    const queueResult = await this.webhookEventRepository.queueWebhookEvent({
      tenantKey: tenantContext.client.tenantKey,
      eventType: this.eventType,
      payload,
    });

    if (queueResult.duplicated) {
      this.logger.info({
        msg: 'Duplicate HubSpot webhook detected',
        eventType: this.eventType,
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
      msg: 'HubSpot webhook event queued',
      eventType: this.eventType,
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

export default QueueHubspotWebhookEvent;
