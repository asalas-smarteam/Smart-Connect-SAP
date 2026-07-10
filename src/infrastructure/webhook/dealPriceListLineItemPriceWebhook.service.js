import hubspotAuthService from '../hubspot/hubspotAuthService.js';
import tenantConfigurationService from '../config/tenantConfiguration.service.js';
import logger from '../logger/logger.js';
import SyncDealLineItemPricesByPriceList from '#application/use-cases/SyncDealLineItemPricesByPriceList.js';
import HubspotLineItemPriceClient from '#infrastructure/external-services/HubspotLineItemPriceClient.js';
import SapLineItemPriceClient from '#infrastructure/external-services/SapLineItemPriceClient.js';
import TenantLineItemPriceConfigRepository from '#infrastructure/repositories/TenantLineItemPriceConfigRepository.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';
import {
  assertRequiredWebhookField,
  buildDuplicateFilter,
  extractAssociationIds,
  fetchHubspotObject,
  resolveHubspotCredentials,
  toNonEmptyString,
  toNumberOrNull,
} from './lineItemPriceWebhook.shared.js';

const SUPPORTED_ASSOCIATION_TYPE = 'DEAL_TO_LINE_ITEM';
const SUPPORTED_ASSOCIATION_CHANGE_SOURCE = 'USER';
const SUPPORTED_LINE_ITEM_SUBSCRIPTION = 'line_item.propertyChange';
const SUPPORTED_DEAL_SUBSCRIPTION = 'deal.propertyChange';
// CRM_UI evita bucles: las escrituras del propio integrador llegan con changeSource INTEGRATION.
const SUPPORTED_PROPERTY_CHANGE_SOURCE = 'CRM_UI';

// Debounce por deal: reutiliza la misma config del modo SkippedVersion legacy.
const DEBOUNCE_CONFIG_KEY = 'requireSkippedInWebhooksInPropertyChange';
const DEBOUNCE_DEFAULT = { requireSkipped: true, secondsToSkipped: 3 };
const DUPLICATE_ERROR_MESSAGE = 'Duplicate event';
const DEBOUNCED_ERROR_MESSAGE = 'evento skipeado por envios multiples';
const HANDLED_REASON = 'deal_line_items_price_list_recalculated';

function skipResult(reason, extraMeta = {}) {
  return {
    skip: true,
    payload: null,
    executionId: null,
    meta: {
      skipped: true,
      reason,
      ...extraMeta,
    },
  };
}

function classifyEvent(payload = {}, strategyConfig = {}) {
  if (
    payload?.associationType === SUPPORTED_ASSOCIATION_TYPE
    && payload?.changeSource === SUPPORTED_ASSOCIATION_CHANGE_SOURCE
  ) {
    return 'association';
  }

  if (
    payload?.subscriptionType === SUPPORTED_DEAL_SUBSCRIPTION
    && payload?.propertyName === strategyConfig.dealPriceListProperty
    && payload?.changeSource === SUPPORTED_PROPERTY_CHANGE_SOURCE
  ) {
    return 'dealPropertyChange';
  }

  if (
    payload?.subscriptionType === SUPPORTED_LINE_ITEM_SUBSCRIPTION
    && payload?.propertyName === strategyConfig.lineItemPriceListProperty
    && payload?.changeSource === SUPPORTED_PROPERTY_CHANGE_SOURCE
  ) {
    return 'lineItemPropertyChange';
  }

  return null;
}

export class DealPriceListLineItemPriceWebhookService {
  constructor({
    syncDealLineItemPrices,
    hubspotAuth = hubspotAuthService,
    tenantConfiguration = tenantConfigurationService,
    log = logger,
  } = {}) {
    this.syncDealLineItemPrices = syncDealLineItemPrices
      || new SyncDealLineItemPricesByPriceList({
        credentialRepository: new TenantLineItemPriceConfigRepository(),
        sapPriceClient: new SapLineItemPriceClient(),
        hubspotPriceClient: new HubspotLineItemPriceClient(),
        buildErrorResponseSnapshot,
        buildWebhookSyncErrorEntry,
        logger,
      });
    this.hubspotAuth = hubspotAuth;
    this.tenantConfiguration = tenantConfiguration;
    this.log = log;
  }

  async preparePayload(payload, { tenantModels, tenant, tenantKey, strategyConfig }) {
    const eventKind = classifyEvent(payload, strategyConfig);

    if (!eventKind) {
      return skipResult('unsupported_event');
    }

    assertRequiredWebhookField(payload, 'portalId');
    assertRequiredWebhookField(payload, 'eventId');
    assertRequiredWebhookField(payload, 'subscriptionId');
    assertRequiredWebhookField(payload, 'appId');
    assertRequiredWebhookField(payload, 'occurredAt');
    assertRequiredWebhookField(payload, eventKind === 'association' ? 'fromObjectId' : 'objectId');

    const { LineItemPriceWebhookEvent } = tenantModels;
    const duplicate = await this.findDuplicate(LineItemPriceWebhookEvent, payload, eventKind);

    if (duplicate) {
      await LineItemPriceWebhookEvent.create({
        payload,
        isSend: false,
        errorMessage: DUPLICATE_ERROR_MESSAGE,
      });

      return skipResult('duplicate_event');
    }

    const dealId = await this.resolveDealId(payload, eventKind, { tenantModels, tenant });

    if (!dealId) {
      await LineItemPriceWebhookEvent.create({
        payload,
        isSend: false,
        errorMessage: 'Line item has no associated deal',
      });

      throw new Error('Line item has no associated deal');
    }

    const debounced = await this.isDebounced(LineItemPriceWebhookEvent, dealId, tenantModels);

    if (debounced) {
      await LineItemPriceWebhookEvent.create({
        payload,
        dealId,
        isSend: false,
        errorMessage: DEBOUNCED_ERROR_MESSAGE,
      });

      return skipResult('debounced_event', { dealId });
    }

    // Se crea ANTES de procesar para que webhooks concurrentes del mismo deal se
    // debouncen contra este registro. El recálculo es idempotente (siempre parte
    // de los precios de SAP), así que una carrera solo duplica trabajo.
    const createdEvent = await LineItemPriceWebhookEvent.create({
      payload,
      dealId,
      isSend: false,
      errorMessage: null,
    });

    try {
      const result = await this.syncDealLineItemPrices.execute(
        { dealId, strategyConfig },
        { tenantModels, tenant, tenantKey }
      );

      await LineItemPriceWebhookEvent.updateOne(
        { _id: createdEvent._id },
        { $set: { isSend: true, errorMessage: null } }
      );

      return {
        skip: true,
        payload: null,
        executionId: createdEvent._id,
        meta: {
          skipped: false,
          handled: true,
          reason: HANDLED_REASON,
          eventKind,
          dealId,
          ...result.meta,
        },
      };
    } catch (error) {
      await LineItemPriceWebhookEvent.updateOne(
        { _id: createdEvent._id },
        { $set: { isSend: false, errorMessage: error.message } }
      );

      throw error;
    }
  }

  async findDuplicate(LineItemPriceWebhookEvent, payload, eventKind) {
    // Asociación: reenvíos idénticos de HubSpot comparten todos los identificadores del evento.
    // propertyChange: occurredAt distingue reenvíos de cambios legítimos que vuelven a un valor
    // anterior; solo cuentan eventos exitosos o en vuelo (un reintento tras fallo debe ejecutarse).
    const filter = eventKind === 'association'
      ? buildDuplicateFilter(payload)
      : {
        'payload.objectId': payload.objectId,
        'payload.sourceId': payload.sourceId,
        'payload.propertyValue': payload.propertyValue,
        'payload.occurredAt': payload.occurredAt,
      };

    return LineItemPriceWebhookEvent.findOne({
      ...filter,
      $or: [{ isSend: true }, { errorMessage: null }],
    }).select({ _id: 1 }).lean();
  }

  async resolveDealId(payload, eventKind, { tenantModels, tenant }) {
    if (eventKind === 'association') {
      return toNonEmptyString(payload.fromObjectId);
    }

    if (eventKind === 'dealPropertyChange') {
      return toNonEmptyString(payload.objectId);
    }

    const hubspotCredentials = await resolveHubspotCredentials(tenantModels, tenant);
    const token = await this.hubspotAuth.getAccessToken(
      hubspotCredentials.clientConfigId,
      hubspotCredentials,
      tenantModels
    );
    const lineItem = await fetchHubspotObject(token, 'line_items', payload.objectId, {
      associations: ['deals'],
    });

    return extractAssociationIds(lineItem, 'deals')[0] ?? null;
  }

  async isDebounced(LineItemPriceWebhookEvent, dealId, tenantModels) {
    const debounceConfig = await this.tenantConfiguration.getValue(
      tenantModels,
      DEBOUNCE_CONFIG_KEY,
      DEBOUNCE_DEFAULT
    );

    if (debounceConfig?.requireSkipped !== true) {
      return false;
    }

    const secondsToSkipped = toNumberOrNull(debounceConfig?.secondsToSkipped)
      ?? DEBOUNCE_DEFAULT.secondsToSkipped;

    // Solo cuentan registros sin errorMessage: los skipped/duplicados no extienden
    // la ventana y un reintento tras fallo no se debouncea.
    const recentExecution = await LineItemPriceWebhookEvent.findOne({
      dealId,
      createdAt: { $gte: new Date(Date.now() - secondsToSkipped * 1000) },
      errorMessage: null,
    }).select({ _id: 1 }).lean();

    return Boolean(recentExecution);
  }
}

export const dealPriceListLineItemPriceWebhookService = new DealPriceListLineItemPriceWebhookService();

export default dealPriceListLineItemPriceWebhookService;
