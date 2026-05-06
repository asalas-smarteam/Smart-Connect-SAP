import { tenantResolver } from '../middlewares/tenantResolver.js';
import QueueHubspotCreateDealWebhook from '../../../application/use-cases/QueueHubspotCreateDealWebhook.js';
import MongooseQueuedWebhookEventRepository from '../../../infrastructure/database/repositories/MongooseQueuedWebhookEventRepository.js';
import { webhookQueueAdapter } from '../../../infrastructure/queue/webhook.queue.adapter.js';
import ActiveTenantSubscriptionResolver from '../../../infrastructure/tenants/ActiveTenantSubscriptionResolver.js';
import logger from '../../../infrastructure/logger/logger.adapter.js';
import { createWebhookController } from '../controllers/webhook.controller.js';

function buildWebhookController() {
  const queueHubspotCreateDealWebhook = new QueueHubspotCreateDealWebhook({
    activeTenantResolver: new ActiveTenantSubscriptionResolver(),
    webhookEventRepository: new MongooseQueuedWebhookEventRepository(),
    webhookQueue: webhookQueueAdapter,
    logger,
  });

  return createWebhookController({
    queueHubspotCreateDealWebhook,
    logger,
  });
}

export default async function routes(app) {
  app.post(
    '/webhooks/hubspot/createDeal', 
    {preHandler: tenantResolver}, 
    buildWebhookController()
  );
}
