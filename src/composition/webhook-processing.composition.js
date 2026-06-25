import ProcessHubspotConvertQuotationToOrder from '#application/use-cases/ProcessHubspotConvertQuotationToOrder.js';
import ProcessHubspotCreateQuotation from '#application/use-cases/ProcessHubspotCreateQuotation.js';
import ProcessHubspotUpdateQuotation from '#application/use-cases/ProcessHubspotUpdateQuotation.js';
import ProcessHubspotWebhookEvent from '#application/use-cases/ProcessHubspotWebhookEvent.js';
import ProcessWebhookDealEventBatch from '#application/use-cases/ProcessWebhookDealEventBatch.js';
import MongooseSapDocumentLinkRepository from '#infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';
import MongooseWebhookEventProgressRepository from '#infrastructure/database/repositories/MongooseWebhookEventProgressRepository.js';
import MongooseWebhookReferenceRepository from '#infrastructure/database/repositories/MongooseWebhookReferenceRepository.js';
import TenantWebhookRuntimeRepository from '#infrastructure/database/repositories/TenantWebhookRuntimeRepository.js';
import HubspotWebhookAdapter from '#infrastructure/hubspot/HubspotWebhookAdapter.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import MongooseWebhookEventRepository from '#infrastructure/repositories/MongooseWebhookEventRepository.js';
import SapWebhookOrderAdapter from '#infrastructure/sap/SapWebhookOrderAdapter.js';
import SapWebhookQuotationAdapter from '#infrastructure/sap/SapWebhookQuotationAdapter.js';
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
    webhookEventProgressRepository: new MongooseWebhookEventProgressRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}

export function buildProcessHubspotCreateQuotationUseCase() {
  return new ProcessHubspotCreateQuotation({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    sapQuotationAdapter: new SapWebhookQuotationAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}

export function buildProcessHubspotUpdateQuotationUseCase() {
  return new ProcessHubspotUpdateQuotation({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapQuotationAdapter: new SapWebhookQuotationAdapter(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}

export function buildProcessHubspotConvertQuotationToOrderUseCase() {
  return new ProcessHubspotConvertQuotationToOrder({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger,
  });
}

// Routes each claimed webhook event to the right use case by its eventType. Unknown
// event types fall back to the existing createDeal flow so current behaviour is preserved.
export function buildWebhookEventDispatcher({
  processHubspotWebhookEvent = buildProcessHubspotWebhookEventUseCase(),
  processHubspotCreateQuotation = buildProcessHubspotCreateQuotationUseCase(),
  processHubspotUpdateQuotation = buildProcessHubspotUpdateQuotationUseCase(),
  processHubspotConvertQuotationToOrder = buildProcessHubspotConvertQuotationToOrderUseCase(),
} = {}) {
  const handlers = {
    createDeal: processHubspotWebhookEvent,
    createQuotation: processHubspotCreateQuotation,
    updateQuotation: processHubspotUpdateQuotation,
    convertQuotationToOrder: processHubspotConvertQuotationToOrder,
  };

  return (input) => {
    const handler = handlers[input?.event?.eventType] || processHubspotWebhookEvent;
    return handler.execute(input);
  };
}

export function buildWebhookEventRepository({ WebhookEvent, batchSize }) {
  return new MongooseWebhookEventRepository({ WebhookEvent, batchSize });
}

export function buildProcessWebhookDealEventBatch({
  webhookEventRepository,
  processWebhookDealEvent = buildWebhookEventDispatcher(),
  maxRetries,
} = {}) {
  return new ProcessWebhookDealEventBatch({
    webhookEventRepository,
    processWebhookDealEvent,
    logger,
    maxRetries,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
  });
}
