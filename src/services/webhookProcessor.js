import logger from '../infrastructure/logger/logger.adapter.js';
import ProcessWebhookDealEventBatch from '../application/use-cases/ProcessWebhookDealEventBatch.js';
import ProcessHubspotWebhookEvent from '../application/use-cases/ProcessHubspotWebhookEvent.js';
import MongooseWebhookEventRepository from '../infrastructure/repositories/MongooseWebhookEventRepository.js';
import TenantWebhookRuntimeRepository from '../infrastructure/database/repositories/TenantWebhookRuntimeRepository.js';
import MongooseWebhookReferenceRepository from '../infrastructure/database/repositories/MongooseWebhookReferenceRepository.js';
import SapWebhookOrderAdapter from '../infrastructure/sap/SapWebhookOrderAdapter.js';
import HubspotWebhookAdapter from '../infrastructure/hubspot/HubspotWebhookAdapter.js';

import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from './syncLog.service.js';

const DEFAULT_BATCH_SIZE = Number(process.env.WEBHOOK_EVENT_BATCH_SIZE || 10);
const DEFAULT_MAX_RETRIES = Number(process.env.WEBHOOK_EVENT_MAX_RETRIES || 3);

function createProcessHubspotWebhookEventUseCase() {
  return new ProcessHubspotWebhookEvent({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
  });
}

export async function claimEventsToProcess(WebhookEvent, batchSize = DEFAULT_BATCH_SIZE) {
  const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize });
  return repository.claimWaiting();
}

const webhookProcessor = {
  async processPendingEvents({ tenantModels, tenantId, tenantKey, portalId } = {}) {
    if (!tenantModels) {
      throw new Error('Tenant models are required to process webhook events');
    }

    const maxRetriesByEnv = Math.max(
      1,
      Number(process.env.WEBHOOK_EVENT_MAX_RETRIES || DEFAULT_MAX_RETRIES)
    );
    const repository = new MongooseWebhookEventRepository({
      WebhookEvent: tenantModels?.WebhookEvent,
      batchSize: DEFAULT_BATCH_SIZE,
    });
    const processHubspotWebhookEvent = createProcessHubspotWebhookEventUseCase();
    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: (input) => processHubspotWebhookEvent.execute(input),
      logger,
      maxRetries: maxRetriesByEnv,
      buildWebhookSyncErrorEntry,
      buildErrorResponseSnapshot,
    });

    return useCase.execute({ tenantModels, tenantId, tenantKey, portalId });
  },
};

export default webhookProcessor;
