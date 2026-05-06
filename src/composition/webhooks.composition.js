import QueueHubspotCreateDealWebhook from '#application/use-cases/QueueHubspotCreateDealWebhook.js';
import MongooseQueuedWebhookEventRepository from '#infrastructure/database/repositories/MongooseQueuedWebhookEventRepository.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import { webhookQueueAdapter } from '#infrastructure/queue/webhook.queue.adapter.js';
import ActiveTenantSubscriptionResolver from '#infrastructure/tenants/ActiveTenantSubscriptionResolver.js';
import { createWebhookController } from '#interfaces/http/controllers/webhook.controller.js';

export function buildQueueHubspotCreateDealWebhook() {
  return new QueueHubspotCreateDealWebhook({
    activeTenantResolver: new ActiveTenantSubscriptionResolver(),
    webhookEventRepository: new MongooseQueuedWebhookEventRepository(),
    webhookQueue: webhookQueueAdapter,
    logger,
  });
}

export function buildWebhookController() {
  return createWebhookController({
    queueHubspotCreateDealWebhook: buildQueueHubspotCreateDealWebhook(),
    logger,
  });
}

export default buildWebhookController;
