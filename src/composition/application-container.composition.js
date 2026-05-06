import TenantContextService from '#application/services/tenant-context.service.js';
import { HubspotLineItemPriceClient } from '#infrastructure/external-services/HubspotLineItemPriceClient.js';
import { SapLineItemPriceClient } from '#infrastructure/external-services/SapLineItemPriceClient.js';
import MongooseTenantConfigRepository from '#infrastructure/database/repositories/MongooseTenantConfigRepository.js';
import hubspotClientAdapter from '#infrastructure/hubspot/hubspot-client.adapter.js';
import { loggerAdapter } from '#infrastructure/logger/logger.adapter.js';
import sapSyncQueueAdapter from '#infrastructure/queue/sap-sync.queue.adapter.js';
import webhookQueueAdapter from '#infrastructure/queue/webhook.queue.adapter.js';
import TenantLineItemPriceConfigRepository from '#infrastructure/repositories/TenantLineItemPriceConfigRepository.js';
import MongooseWebhookEventRepository from '#infrastructure/repositories/MongooseWebhookEventRepository.js';
import sapSessionAdapter from '#infrastructure/sap/sap-session.adapter.js';

export function createApplicationContainer() {
  const tenantConfigRepository = new MongooseTenantConfigRepository();

  return {
    logger: loggerAdapter,
    queues: {
      sapSync: sapSyncQueueAdapter,
      webhook: webhookQueueAdapter,
    },
    repositories: {
      tenantConfig: tenantConfigRepository,
      lineItemPriceConfig: new TenantLineItemPriceConfigRepository(),
      webhookEvent: MongooseWebhookEventRepository,
    },
    services: {
      tenantContext: new TenantContextService({ tenantConfigRepository }),
    },
    externalServices: {
      hubspot: hubspotClientAdapter,
      hubspotLineItemPrice: new HubspotLineItemPriceClient(),
      sapLineItemPrice: new SapLineItemPriceClient(),
      sapSession: sapSessionAdapter,
    },
  };
}

export default createApplicationContainer;
