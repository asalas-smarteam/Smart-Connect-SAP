import SyncS4LineItemPricesByPriceList from '#application/use-cases/SyncS4LineItemPricesByPriceList.js';
import HubspotLineItemPriceClient from '#infrastructure/external-services/HubspotLineItemPriceClient.js';
import S4PriceListClient from '#infrastructure/sap/S4PriceListClient.js';
import TenantLineItemPriceConfigRepository from '#infrastructure/repositories/TenantLineItemPriceConfigRepository.js';
import { createSapTransport } from '#infrastructure/sap/transport/sapTransportFactory.js';
import { createSapCallRecorder } from '#infrastructure/sap/sapCallRecorder.js';
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import * as hubspotClient from '#infrastructure/hubspot/hubspotClient.js';
import { buildNotifyLineItemPriceOutcome } from '#infrastructure/hubspot/lineItemPriceNoteNotifier.service.js';
import { getWebhookFailureNotificationConfig } from '#infrastructure/config/webhookFailureNotification.config.js';
import logger from '#infrastructure/logger/logger.js';
import syncLogAdapter from '#infrastructure/sync/SyncLogAdapter.js';
import requestTenantModelsAdapter from '#infrastructure/tenants/RequestTenantModelsAdapter.js';
import s4PriceListLineItemPriceWebhookService from '#infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js';
import {
  buildErrorResponseSnapshot,
  buildLineItemPriceAudit,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';

// El transporte se arma por invocación porque las credenciales son del tenant que llega en el
// request, no de la composición: mismo criterio que S4ContactEnrichmentAdapter.
export function createS4PriceListClient({ sapConfig }) {
  return new S4PriceListClient({
    transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config: sapConfig }),
  });
}

export function buildSyncS4LineItemPrices({ syncLogGateway } = {}) {
  return new SyncS4LineItemPricesByPriceList({
    credentialRepository: new TenantLineItemPriceConfigRepository(),
    createPriceListClient: createS4PriceListClient,
    hubspotPriceClient: new HubspotLineItemPriceClient(),
    buildErrorResponseSnapshot: syncLogGateway
      ? (error) => syncLogGateway.buildErrorResponseSnapshot(error)
      : buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry: syncLogGateway
      ? (entry) => syncLogGateway.buildWebhookSyncErrorEntry(entry)
      : buildWebhookSyncErrorEntry,
    buildLineItemPriceAudit,
    createSapCallRecorder,
    // Misma llave de config (`requireMessageHS`) y mismo par createNote+associate que el aviso
    // de fallo de los webhooks de cotización: para el tenant es una sola cosa que se prende.
    notifyLineItemPriceOutcome: buildNotifyLineItemPriceOutcome({
      hubspotClient,
      getWebhookFailureNotificationConfig,
      logger,
    }),
    // Explícito y no por default del constructor: el patrón del default silencioso ya dejó
    // dependencias sin cablear tres veces en este repo, y esta decide la fecha con la que se
    // filtra la vigencia de las condiciones en SAP.
    dateProvider: () => new Date(),
    logger,
  });
}

export function buildS4LineItemPriceControllerDependencies({
  tenantModelsResolver = requestTenantModelsAdapter,
  webhookPayload = s4PriceListLineItemPriceWebhookService,
  syncLogGateway = syncLogAdapter,
  syncLineItemPrices,
} = {}) {
  return {
    tenantModelsResolver,
    webhookPayload,
    syncLogGateway,
    syncLineItemPrices: syncLineItemPrices || buildSyncS4LineItemPrices({ syncLogGateway }),
  };
}

export default buildSyncS4LineItemPrices;
