import SyncLineItemPrices from '#application/use-cases/SyncLineItemPrices.js';
import HubspotLineItemPriceClient from '#infrastructure/external-services/HubspotLineItemPriceClient.js';
import SapLineItemPriceClient from '#infrastructure/external-services/SapLineItemPriceClient.js';
import TenantLineItemPriceConfigRepository from '#infrastructure/repositories/TenantLineItemPriceConfigRepository.js';
import syncLogAdapter from '#infrastructure/sync/SyncLogAdapter.js';
import requestTenantModelsAdapter from '#infrastructure/tenants/RequestTenantModelsAdapter.js';
import lineItemPriceWebhookPayloadAdapter from '#infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';

export function buildSyncLineItemPrices({
  syncLogGateway,
  buildErrorResponse = buildErrorResponseSnapshot,
  buildWebhookErrorEntry = buildWebhookSyncErrorEntry,
} = {}) {
  return new SyncLineItemPrices({
    credentialRepository: new TenantLineItemPriceConfigRepository(),
    sapPriceClient: new SapLineItemPriceClient(),
    hubspotPriceClient: new HubspotLineItemPriceClient(),
    buildErrorResponseSnapshot: syncLogGateway
      ? (error) => syncLogGateway.buildErrorResponseSnapshot(error)
      : buildErrorResponse,
    buildWebhookSyncErrorEntry: syncLogGateway
      ? (entry) => syncLogGateway.buildWebhookSyncErrorEntry(entry)
      : buildWebhookErrorEntry,
  });
}

export function buildLineItemPriceControllerDependencies({
  tenantModelsResolver = requestTenantModelsAdapter,
  webhookPayload = lineItemPriceWebhookPayloadAdapter,
  syncLogGateway = syncLogAdapter,
  syncLineItemPrices,
} = {}) {
  return {
    tenantModelsResolver,
    webhookPayload,
    syncLogGateway,
    syncLineItemPrices:
      syncLineItemPrices || buildSyncLineItemPrices({ syncLogGateway }),
  };
}

export default buildSyncLineItemPrices;
