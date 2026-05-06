import {
  buildProcessHubspotWebhookEventUseCase,
  buildProcessWebhookDealEventBatch,
  buildWebhookEventRepository,
} from '#composition/webhook-processing.composition.js';

const DEFAULT_BATCH_SIZE = Number(process.env.WEBHOOK_EVENT_BATCH_SIZE || 10);
const DEFAULT_MAX_RETRIES = Number(process.env.WEBHOOK_EVENT_MAX_RETRIES || 3);

export async function claimEventsToProcess(WebhookEvent, batchSize = DEFAULT_BATCH_SIZE) {
  const repository = buildWebhookEventRepository({ WebhookEvent, batchSize });
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
    const repository = buildWebhookEventRepository({
      WebhookEvent: tenantModels?.WebhookEvent,
      batchSize: DEFAULT_BATCH_SIZE,
    });
    const processHubspotWebhookEvent = buildProcessHubspotWebhookEventUseCase();
    const useCase = buildProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      maxRetries: maxRetriesByEnv,
      processHubspotWebhookEvent,
    });

    return useCase.execute({ tenantModels, tenantId, tenantKey, portalId });
  },
};

export default webhookProcessor;
