import ProcessHubspotConvertQuotationToOrder from '#application/use-cases/ProcessHubspotConvertQuotationToOrder.js';
import ProcessHubspotCreateQuotation from '#application/use-cases/ProcessHubspotCreateQuotation.js';
import ProcessHubspotInventoryTransferRequest from '#application/use-cases/ProcessHubspotInventoryTransferRequest.js';
import ProcessHubspotUpdateQuotation from '#application/use-cases/ProcessHubspotUpdateQuotation.js';
import ProcessHubspotWebhookEvent from '#application/use-cases/ProcessHubspotWebhookEvent.js';
import ProcessWebhookDealEventBatch from '#application/use-cases/ProcessWebhookDealEventBatch.js';
import { resolveEventPayload } from '#application/services/webhook-payload.service.js';
import MongooseSapDocumentLinkRepository from '#infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';
import MongooseWebhookEventProgressRepository from '#infrastructure/database/repositories/MongooseWebhookEventProgressRepository.js';
import MongooseWebhookReferenceRepository from '#infrastructure/database/repositories/MongooseWebhookReferenceRepository.js';
import TenantWebhookRuntimeRepository from '#infrastructure/database/repositories/TenantWebhookRuntimeRepository.js';
import { getWebhookFailureNotificationConfig } from '#infrastructure/config/webhookFailureNotification.config.js';
import hubspotClient from '#infrastructure/hubspot/hubspot-client.adapter.js';
import HubspotWebhookAdapter from '#infrastructure/hubspot/HubspotWebhookAdapter.js';
import { buildNotifyWebhookFailure } from '#infrastructure/hubspot/webhookFailureNotifier.service.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import MongooseWebhookEventRepository from '#infrastructure/repositories/MongooseWebhookEventRepository.js';
import SapWebhookInventoryTransferRequestAdapter from '#infrastructure/sap/SapWebhookInventoryTransferRequestAdapter.js';
import SapWebhookOrderAdapter from '#infrastructure/sap/SapWebhookOrderAdapter.js';
import SapWebhookQuotationAdapter from '#infrastructure/sap/SapWebhookQuotationAdapter.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSapAudit,
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
    buildWebhookSapAudit,
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
    buildWebhookSapAudit,
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
    buildWebhookSapAudit,
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
    buildWebhookSapAudit,
    logger,
  });
}

export function buildProcessHubspotInventoryTransferRequestUseCase() {
  return new ProcessHubspotInventoryTransferRequest({
    runtimeRepository: new TenantWebhookRuntimeRepository(),
    sapOrderAdapter: new SapWebhookOrderAdapter(),
    sapInventoryTransferRequestAdapter: new SapWebhookInventoryTransferRequestAdapter(),
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    webhookReferenceRepository: new MongooseWebhookReferenceRepository(),
    sapDocumentLinkRepository: new MongooseSapDocumentLinkRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    logger,
  });
}

// Routes each claimed webhook event to the right use case by its eventType. An eventType
// that is absent (legacy events queued before the field existed) falls back to the
// createDeal flow. An eventType that is present but unrecognized fails loudly instead of
// silently falling back: falling back used to route it to createDeal, which creates a real
// Sales Order in SAP -- a single typo between the route and this handler map would create
// orders for documents that were never meant to be orders.
export function buildWebhookEventDispatcher({
  processHubspotWebhookEvent = buildProcessHubspotWebhookEventUseCase(),
  processHubspotCreateQuotation = buildProcessHubspotCreateQuotationUseCase(),
  processHubspotUpdateQuotation = buildProcessHubspotUpdateQuotationUseCase(),
  processHubspotConvertQuotationToOrder = buildProcessHubspotConvertQuotationToOrderUseCase(),
  processHubspotInventoryTransferRequest = buildProcessHubspotInventoryTransferRequestUseCase(),
} = {}) {
  const handlers = {
    createDeal: processHubspotWebhookEvent,
    createQuotation: processHubspotCreateQuotation,
    updateQuotation: processHubspotUpdateQuotation,
    convertQuotationToOrder: processHubspotConvertQuotationToOrder,
    inventoryTransferRequest: processHubspotInventoryTransferRequest,
  };

  return async (input) => {
    const eventType = input?.event?.eventType;
    const handler = eventType ? handlers[eventType] : processHubspotWebhookEvent;

    if (!handler) {
      throw new PermanentWebhookError(`Unsupported webhook eventType: ${eventType}`);
    }

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
  notifyWebhookFailure = buildNotifyWebhookFailure({
    hubspotClient,
    hubspotWebhookAdapter: new HubspotWebhookAdapter(),
    getWebhookFailureNotificationConfig,
    resolveEventPayload,
    logger,
  }),
} = {}) {
  return new ProcessWebhookDealEventBatch({
    webhookEventRepository,
    processWebhookDealEvent,
    logger,
    maxRetries,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    notifyWebhookFailure,
  });
}
