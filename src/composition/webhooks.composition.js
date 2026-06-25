import QueueHubspotWebhookEvent from '#application/use-cases/QueueHubspotWebhookEvent.js';
import MongooseQueuedWebhookEventRepository from '#infrastructure/database/repositories/MongooseQueuedWebhookEventRepository.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import { webhookQueueAdapter } from '#infrastructure/queue/webhook.queue.adapter.js';
import ActiveTenantSubscriptionResolver from '#infrastructure/tenants/ActiveTenantSubscriptionResolver.js';
import { createWebhookController } from '#interfaces/http/controllers/webhook.controller.js';

export function buildQueueHubspotWebhookEvent(eventType = 'createDeal') {
  return new QueueHubspotWebhookEvent({
    activeTenantResolver: new ActiveTenantSubscriptionResolver(),
    webhookEventRepository: new MongooseQueuedWebhookEventRepository(),
    webhookQueue: webhookQueueAdapter,
    logger,
    eventType,
  });
}

export function buildQueueHubspotCreateDealWebhook() {
  return buildQueueHubspotWebhookEvent('createDeal');
}

export function buildWebhookController(eventType = 'createDeal') {
  return createWebhookController({
    queueHubspotWebhookEvent: buildQueueHubspotWebhookEvent(eventType),
    eventType,
    logger,
  });
}

export function buildCreateDealController() {
  return buildWebhookController('createDeal');
}

export function buildCreateQuotationController() {
  return buildWebhookController('createQuotation');
}

export function buildUpdateQuotationController() {
  return buildWebhookController('updateQuotation');
}

export function buildConvertQuotationToOrderController() {
  return buildWebhookController('convertQuotationToOrder');
}

export default buildWebhookController;
