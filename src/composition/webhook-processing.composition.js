import ProcessHubspotWebhookEvent from '#application/use-cases/ProcessHubspotWebhookEvent.js';
import ProcessWebhookDealEventBatch from '#application/use-cases/ProcessWebhookDealEventBatch.js';
import MongooseWebhookReferenceRepository from '#infrastructure/database/repositories/MongooseWebhookReferenceRepository.js';
import TenantWebhookRuntimeRepository from '#infrastructure/database/repositories/TenantWebhookRuntimeRepository.js';
import HubspotWebhookAdapter from '#infrastructure/hubspot/HubspotWebhookAdapter.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import MongooseWebhookEventRepository from '#infrastructure/repositories/MongooseWebhookEventRepository.js';
import SapWebhookOrderAdapter from '#infrastructure/sap/SapWebhookOrderAdapter.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';

export function buildProcessHubspotWebhookEventUseCase() {
  return new ProcessHubspotWebhookEvent({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
  });
}

export function buildWebhookEventRepository({ WebhookEvent, batchSize }) {
  return new MongooseWebhookEventRepository({ WebhookEvent, batchSize });
}

export function buildProcessWebhookDealEventBatch({
  webhookEventRepository,
  processHubspotWebhookEvent = buildProcessHubspotWebhookEventUseCase(),
  maxRetries,
} = {}) {
  return new ProcessWebhookDealEventBatch({
    webhookEventRepository,
    processWebhookDealEvent: (input) => processHubspotWebhookEvent.execute(input),
    logger,
    maxRetries,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
  });
}
