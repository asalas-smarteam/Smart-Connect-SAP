import hubspotAuthService from '../hubspot/hubspotAuthService.js';
import * as hubspotClient from '../hubspot/hubspotClient.js';
import tenantConfigurationService from '../config/tenantConfiguration.service.js';

// Conjunto 1: cambio de asociación deal <-> line item
const SUPPORTED_ASSOCIATION_TYPE = 'DEAL_TO_LINE_ITEM';
const SUPPORTED_CHANGE_SOURCE = 'USER';

// Conjunto 2: cambio de propiedad del line item
const SUPPORTED_SUBSCRIPTION_TYPE = 'line_item.propertyChange';
const SUPPORTED_PROPERTY_NAME = 'miscelaneo';
const SUPPORTED_CHANGE_SOURCE_PROPERTY = 'CRM_UI';

// Modo del flujo de cambio de propiedad: 'Legacy' (actualiza solo el line item del webhook)
// o 'SkippedVersion' (recalcula todos los line items del deal con debounce por deal).
const PROPERTY_CHANGE_MODE_CONFIG_KEY = 'skippedInWebhooksInPropertyChange';
const PROPERTY_CHANGE_MODE_DEFAULT = 'Legacy';
const PROPERTY_CHANGE_MODE_SKIPPED = 'SkippedVersion';
const PROPERTY_CHANGE_DEBOUNCE_CONFIG_KEY = 'requireSkippedInWebhooksInPropertyChange';
const PROPERTY_CHANGE_DEBOUNCE_DEFAULT = { requireSkipped: true, secondsToSkipped: 3 };
const DUPLICATE_ERROR_MESSAGE = 'Duplicate event';
const DEBOUNCED_ERROR_MESSAGE = 'evento skipeado por envios multiples';

// Marcador de descarte por condición de carrera (misc llegó antes que la asociación)
export const SKIPPED_MISC_PENDING_ASSOC_MARKER = 'skipped_misc_pending_assoc';
const SKIPPED_MISC_ERROR_MESSAGE =
  `${SKIPPED_MISC_PENDING_ASSOC_MARKER}: safe_price_value not yet available — ` +
  'the pending deal.associationChange will recalculate the price when it runs';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function isLegacyPayload(payload = {}) {
  return Array.isArray(payload?.lineItems);
}

function buildDuplicateFilter(payload = {}) {
  return {
    'payload.eventId': payload.eventId,
    'payload.subscriptionId': payload.subscriptionId,
    'payload.portalId': payload.portalId,
    'payload.appId': payload.appId,
    'payload.occurredAt': payload.occurredAt,
    'payload.fromObjectId': payload.fromObjectId,
  };
}

function assertRequiredWebhookField(payload, fieldName) {
  if (payload?.[fieldName] === undefined || payload?.[fieldName] === null || payload?.[fieldName] === '') {
    throw new Error(`${fieldName} is required`);
  }
}

async function resolveHubspotCredentials(tenantModels, tenant) {
  const { HubspotCredentials } = tenantModels;
  const portalId = toNonEmptyString(tenant?.client?.hubspot?.portalId);

  if (portalId) {
    const byPortalId = await HubspotCredentials.findOne({ portalId });
    if (byPortalId) {
      return byPortalId;
    }
  }

  const credentials = await HubspotCredentials.findOne({});
  if (!credentials) {
    throw new Error('HubSpot credentials not found for tenant');
  }

  return credentials;
}

async function fetchHubspotObject(token, objectType, objectId, { properties = [], associations = [] } = {}) {
  const params = {};

  if (properties.length > 0) {
    params.properties = properties.join(',');
  }

  if (associations.length > 0) {
    params.associations = associations.join(',');
  }

  return hubspotClient.hubspotGet(
    token,
    `/crm/v3/objects/${objectType}/${encodeURIComponent(String(objectId))}`,
    params
  );
}

async function resolveMiscPriceCalculationConfig(tenantModels) {
  const Configuration = tenantModels?.Configuration;

  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key: 'requireExtraValueInUnitPrice' });
  const configuration = typeof query?.lean === 'function'
    ? await query.lean()
    : await query;

  return configuration?.value ?? null;
}

function extractAssociationIds(record, associationName) {
  const results = Array.isArray(record?.associations?.[associationName]?.results)
    ? record.associations[associationName].results
    : [];

  return results
    .map((item) => toNonEmptyString(item?.id))
    .filter(Boolean);
}

function resolveObjectIdSap(record) {
  return (
    toNonEmptyString(record?.properties?.idsap)
    || toNonEmptyString(record?.properties?.idSap)
  );
}

async function resolveCardCode(token, deal) {
  const companyIds = extractAssociationIds(deal, 'companies');
  const contactIds = extractAssociationIds(deal, 'contacts');

  if (companyIds.length === 0 && contactIds.length === 0) {
    throw new Error('Associated company or contact is required for the deal');
  }

  if (companyIds.length > 0) {
    const company = await fetchHubspotObject(token, 'companies', companyIds[0], {
      properties: ['idsap', 'idSap'],
    });
    const cardCode = resolveObjectIdSap(company);

    if (cardCode) {
      return cardCode;
    }
  }

  if (contactIds.length > 0) {
    const contact = await fetchHubspotObject(token, 'contacts', contactIds[0], {
      properties: ['idsap', 'idSap'],
    });
    const cardCode = resolveObjectIdSap(contact);

    if (cardCode) {
      return cardCode;
    }
  }

  return null;
}

async function resolveLineItems(token, deal, miscPriceCalculationConfig = null) {
  const lineItemIds = [
    ...extractAssociationIds(deal, 'line_items'),
    ...extractAssociationIds(deal, 'lineItems'),
    ...extractAssociationIds(deal, 'line items'),
    ...extractAssociationIds(deal, 'products'),
  ].filter((value, index, items) => items.indexOf(value) === index);

  if (lineItemIds.length === 0) {
    throw new Error('Deal has no associated line items');
  }

  const miscSourceProperty = miscPriceCalculationConfig?.enableMiscPriceCalculation === true
    ? toNonEmptyString(miscPriceCalculationConfig?.miscSourceProperty)
    : null;
  const lineItemProperties = ['hs_sku', 'quantity', miscSourceProperty]
    .filter((value, index, values) => value && values.indexOf(value) === index);

  const lineItems = await Promise.all(
    lineItemIds.map(async (lineItemId, index) => {
      const lineItem = await fetchHubspotObject(token, 'line_items', lineItemId, {
        properties: lineItemProperties,
      });
      const itemCode = toNonEmptyString(lineItem?.properties?.hs_sku || lineItem?.properties?.itemCode);

      if (!itemCode) {
        throw new Error(`lineItems[${index}].itemCode is required`);
      }

      return {
        id: toNonEmptyString(lineItem?.id) || lineItemId,
        itemCode,
        quantity: lineItem?.properties?.quantity ?? null,
        ...(miscSourceProperty
          ? { [miscSourceProperty]: lineItem?.properties?.[miscSourceProperty] ?? null }
          : {}),
      };
    })
  );

  return lineItems;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Flujo de cambio de propiedad: precio = safe_price_value * (1 + miscelaneo / 100).
// Es idempotente porque siempre parte del precio base (safe_price_value).
async function recalculateLineItemPriceFromMisc(payload, token) {
  const lineItemId = toNonEmptyString(payload?.objectId);

  if (!lineItemId) {
    throw new Error('objectId is required');
  }

  const lineItem = await fetchHubspotObject(token, 'line_items', lineItemId, {
    properties: ['price', 'miscelaneo', 'safe_price_value'],
  });

  const safePrice = toNumberOrNull(lineItem?.properties?.safe_price_value);

  if (safePrice === null) {
    throw new Error('safe_price_value is required to recalculate line item price');
  }

  const misc = toNumberOrNull(lineItem?.properties?.miscelaneo) ?? 0;
  const newPrice = safePrice + (safePrice * misc) / 100;

  await hubspotClient.batchUpdateLineItems(token, {
    inputs: [{ id: lineItemId, properties: { price: String(newPrice) } }],
  });

  return { lineItemId, safePrice, misc, price: newPrice };
}

async function handlePropertyChangeEvent(payload, { tenantModels, tenant }) {
  if (payload?.portalId === undefined || payload?.portalId === null || payload?.portalId === '') {
    throw new Error('portalId is required');
  }

  assertRequiredWebhookField(payload, 'eventId');
  assertRequiredWebhookField(payload, 'subscriptionId');
  assertRequiredWebhookField(payload, 'appId');
  assertRequiredWebhookField(payload, 'occurredAt');
  assertRequiredWebhookField(payload, 'objectId');

  const { LineItemPriceWebhookEvent } = tenantModels;

  // Condición de carrera: si existe un deal.associationChange pendiente para este line item,
  // ese flujo ya recalculará el misceláneo — descartamos este evento sin fallo ni reintento.
  const pendingAssociation = await LineItemPriceWebhookEvent.findOne({
    'payload.subscriptionType': 'deal.associationChange',
    'payload.toObjectId': String(payload.objectId),
    isSend: false,
  }).select({ _id: 1 }).lean();

  if (pendingAssociation) {
    await LineItemPriceWebhookEvent.create({
      payload,
      isSend: false,
      errorMessage: SKIPPED_MISC_ERROR_MESSAGE,
    });

    return {
      skip: true,
      payload: null,
      executionId: null,
      meta: {
        skipped: true,
        reason: SKIPPED_MISC_PENDING_ASSOC_MARKER,
      },
    };
  }

  const createdEvent = await LineItemPriceWebhookEvent.create({
    payload,
    isSend: false,
    errorMessage: null,
  });

  try {
    const hubspotCredentials = await resolveHubspotCredentials(tenantModels, tenant);
    const token = await hubspotAuthService.getAccessToken(
      hubspotCredentials.clientConfigId,
      hubspotCredentials,
      tenantModels
    );

    const result = await recalculateLineItemPriceFromMisc(payload, token);

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
        reason: 'line_item_price_recalculated',
        ...result,
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

// Flujo SkippedVersion: recalcula TODOS los line items del deal, cada uno con su propio
// miscelaneo leído de HubSpot (no se usa payload.propertyValue). Así un solo webhook
// que llegue al integrador "sana" el deal completo aunque los demás se pierdan.
async function recalculateDealLineItemsFromMisc(dealId, token) {
  const deal = await fetchHubspotObject(token, 'deals', dealId, {
    associations: ['line_items'],
  });

  const lineItemIds = [
    ...extractAssociationIds(deal, 'line_items'),
    ...extractAssociationIds(deal, 'lineItems'),
    ...extractAssociationIds(deal, 'line items'),
    ...extractAssociationIds(deal, 'products'),
  ].filter((value, index, items) => items.indexOf(value) === index);

  if (lineItemIds.length === 0) {
    throw new Error('Deal has no associated line items');
  }

  const lineItems = await Promise.all(
    lineItemIds.map((lineItemId) => fetchHubspotObject(token, 'line_items', lineItemId, {
      properties: ['price', 'miscelaneo', 'safe_price_value'],
    }))
  );

  const recalculatedLineItems = [];

  lineItems.forEach((lineItem, index) => {
    const safePrice = toNumberOrNull(lineItem?.properties?.safe_price_value);

    // Sin safe_price_value no hay base para recalcular: se excluye la línea sin fallar el deal.
    if (safePrice === null) {
      return;
    }

    const misc = toNumberOrNull(lineItem?.properties?.miscelaneo) ?? 0;
    const price = safePrice + (safePrice * misc) / 100;

    recalculatedLineItems.push({
      lineItemId: toNonEmptyString(lineItem?.id) || lineItemIds[index],
      safePrice,
      misc,
      price,
    });
  });

  if (recalculatedLineItems.length === 0) {
    throw new Error('safe_price_value is required to recalculate line item price');
  }

  await hubspotClient.batchUpdateLineItems(token, {
    inputs: recalculatedLineItems.map((item) => ({
      id: item.lineItemId,
      properties: { price: String(item.price) },
    })),
  });

  return {
    requestedCount: lineItemIds.length,
    updatedCount: recalculatedLineItems.length,
    lineItems: recalculatedLineItems,
  };
}

async function handlePropertyChangeEventSkipped(payload, { tenantModels, tenant }) {
  if (payload?.portalId === undefined || payload?.portalId === null || payload?.portalId === '') {
    throw new Error('portalId is required');
  }

  assertRequiredWebhookField(payload, 'eventId');
  assertRequiredWebhookField(payload, 'subscriptionId');
  assertRequiredWebhookField(payload, 'appId');
  assertRequiredWebhookField(payload, 'occurredAt');
  assertRequiredWebhookField(payload, 'objectId');

  const { LineItemPriceWebhookEvent } = tenantModels;

  // Duplicado exacto (reenvío de HubSpot): mismo objectId + sourceId + propertyValue + occurredAt.
  // occurredAt distingue reenvíos de cambios legítimos que regresan a un valor anterior.
  // Solo cuentan eventos exitosos (isSend) o en vuelo (errorMessage null): un reintento de
  // HubSpot tras un fallo nuestro debe ejecutarse, no descartarse como duplicado.
  const duplicate = await LineItemPriceWebhookEvent.findOne({
    'payload.objectId': payload.objectId,
    'payload.sourceId': payload.sourceId,
    'payload.propertyValue': payload.propertyValue,
    'payload.occurredAt': payload.occurredAt,
    $or: [{ isSend: true }, { errorMessage: null }],
  }).select({ _id: 1 }).lean();

  if (duplicate) {
    await LineItemPriceWebhookEvent.create({
      payload,
      isSend: false,
      errorMessage: DUPLICATE_ERROR_MESSAGE,
    });

    return {
      skip: true,
      payload: null,
      executionId: null,
      meta: {
        skipped: true,
        reason: 'duplicate_event',
      },
    };
  }

  const debounceConfig = await tenantConfigurationService.getValue(
    tenantModels,
    PROPERTY_CHANGE_DEBOUNCE_CONFIG_KEY,
    PROPERTY_CHANGE_DEBOUNCE_DEFAULT
  );

  const hubspotCredentials = await resolveHubspotCredentials(tenantModels, tenant);
  const token = await hubspotAuthService.getAccessToken(
    hubspotCredentials.clientConfigId,
    hubspotCredentials,
    tenantModels
  );

  const lineItem = await fetchHubspotObject(token, 'line_items', payload.objectId, {
    associations: ['deals'],
  });
  const dealId = extractAssociationIds(lineItem, 'deals')[0];

  if (!dealId) {
    await LineItemPriceWebhookEvent.create({
      payload,
      isSend: false,
      errorMessage: 'Line item has no associated deal',
    });

    throw new Error('Line item has no associated deal');
  }

  // Debounce por deal: si ya se ejecutó algo para este deal dentro de la ventana, este
  // webhook sobra (el que ejecutó ya recalculó todas las líneas). Solo cuentan registros
  // sin errorMessage: los skipped/duplicados no extienden la ventana (una ráfaga podría
  // suprimir el procesamiento indefinidamente) y un reintento tras fallo no se debouncea.
  if (debounceConfig?.requireSkipped === true) {
    const secondsToSkipped = toNumberOrNull(debounceConfig?.secondsToSkipped)
      ?? PROPERTY_CHANGE_DEBOUNCE_DEFAULT.secondsToSkipped;

    const recentExecution = await LineItemPriceWebhookEvent.findOne({
      dealId,
      createdAt: { $gte: new Date(Date.now() - secondsToSkipped * 1000) },
      errorMessage: null,
    }).select({ _id: 1 }).lean();

    if (recentExecution) {
      await LineItemPriceWebhookEvent.create({
        payload,
        dealId,
        isSend: false,
        errorMessage: DEBOUNCED_ERROR_MESSAGE,
      });

      return {
        skip: true,
        payload: null,
        executionId: null,
        meta: {
          skipped: true,
          reason: 'debounced_event',
          dealId,
        },
      };
    }
  }

  // El registro se crea ANTES de procesar: un webhook concurrente del mismo deal que corra
  // su debounce después de este insert lo verá y se skipea. La ventana residual entre el
  // findOne y este create se acepta porque el recálculo es idempotente (parte de
  // safe_price_value): una carrera solo causa trabajo redundante, nunca precios malos.
  const createdEvent = await LineItemPriceWebhookEvent.create({
    payload,
    dealId,
    isSend: false,
    errorMessage: null,
  });

  try {
    const result = await recalculateDealLineItemsFromMisc(dealId, token);

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
        reason: 'deal_line_items_price_recalculated',
        dealId,
        ...result,
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

async function buildLegacyPayload(payload, token, miscPriceCalculationConfig = null) {
  const dealId = toNonEmptyString(payload?.fromObjectId);

  if (!dealId) {
    throw new Error('fromObjectId is required');
  }

  const deal = await fetchHubspotObject(token, 'deals', dealId, {
    associations: ['companies', 'contacts', 'line_items'],
  });

  return {
    dealId,
    cardCode: await resolveCardCode(token, deal),
    lineItems: await resolveLineItems(token, deal, miscPriceCalculationConfig),
  };
}

const lineItemPriceWebhookService = {
  isLegacyPayload,

  async preparePayload(payload, { tenantModels, tenant }) {
    if (isLegacyPayload(payload)) {
      return {
        skip: false,
        payload: {
          ...payload,
          dealId: toNonEmptyString(payload?.dealId) || toNonEmptyString(payload?.fromObjectId),
        },
        executionId: null,
      };
    }

    const isSupportedAssociationEvent =
      payload?.associationType === SUPPORTED_ASSOCIATION_TYPE
      && payload?.changeSource === SUPPORTED_CHANGE_SOURCE;

    const isSupportedPropertyEvent =
      payload?.subscriptionType === SUPPORTED_SUBSCRIPTION_TYPE
      && payload?.propertyName === SUPPORTED_PROPERTY_NAME
      && payload?.changeSource === SUPPORTED_CHANGE_SOURCE_PROPERTY;

    if (!isSupportedAssociationEvent && !isSupportedPropertyEvent) {
      return {
        skip: true,
        payload: null,
        executionId: null,
        meta: {
          skipped: true,
          reason: 'unsupported_event',
        },
      };
    }

    // Flujo de cambio de propiedad: recalcula y actualiza el precio del line item.
    // El modo se conmuta por configuración: 'Legacy' mantiene el flujo original intacto.
    if (isSupportedPropertyEvent) {
      const propertyChangeMode = await tenantConfigurationService.getValue(
        tenantModels,
        PROPERTY_CHANGE_MODE_CONFIG_KEY,
        PROPERTY_CHANGE_MODE_DEFAULT
      );

      if (propertyChangeMode === PROPERTY_CHANGE_MODE_SKIPPED) {
        return handlePropertyChangeEventSkipped(payload, { tenantModels, tenant });
      }

      return handlePropertyChangeEvent(payload, { tenantModels, tenant });
    }

    if (payload?.portalId === undefined || payload?.portalId === null || payload?.portalId === '') {
      throw new Error('portalId is required');
    }

    assertRequiredWebhookField(payload, 'eventId');
    assertRequiredWebhookField(payload, 'subscriptionId');
    assertRequiredWebhookField(payload, 'appId');
    assertRequiredWebhookField(payload, 'occurredAt');
    assertRequiredWebhookField(payload, 'fromObjectId');

    const { LineItemPriceWebhookEvent } = tenantModels;
    const duplicateFilter = buildDuplicateFilter(payload);
    const duplicate = await LineItemPriceWebhookEvent.findOne(duplicateFilter)
      .select({ _id: 1 })
      .lean();

    if (duplicate) {
      return {
        skip: true,
        payload: null,
        executionId: duplicate._id,
        meta: {
          skipped: true,
          reason: 'duplicate_event',
        },
      };
    }

    let createdEvent;

    try {
      createdEvent = await LineItemPriceWebhookEvent.create({
        payload,
        isSend: false,
        errorMessage: null,
      });
    } catch (error) {
      if (error?.code === 11000) {
        return {
          skip: true,
          payload: null,
          executionId: null,
          meta: {
            skipped: true,
            reason: 'duplicate_event',
          },
        };
      }

      throw error;
    }

    try {
      const hubspotCredentials = await resolveHubspotCredentials(tenantModels, tenant);
      const token = await hubspotAuthService.getAccessToken(
        hubspotCredentials.clientConfigId,
        hubspotCredentials,
        tenantModels
      );
      const miscPriceCalculationConfig = await resolveMiscPriceCalculationConfig(tenantModels);

      return {
        skip: false,
        payload: await buildLegacyPayload(payload, token, miscPriceCalculationConfig),
        executionId: createdEvent._id,
      };
    } catch (error) {
      await LineItemPriceWebhookEvent.updateOne(
        { _id: createdEvent._id },
        {
          $set: {
            isSend: false,
            errorMessage: error.message,
          },
        }
      );

      throw error;
    }
  },

  async markAsSent(LineItemPriceWebhookEvent, executionId) {
    if (!LineItemPriceWebhookEvent || !executionId) {
      return;
    }

    await LineItemPriceWebhookEvent.updateOne(
      { _id: executionId },
      {
        $set: {
          isSend: true,
          errorMessage: null,
        },
      }
    );
  },

  async markAsError(LineItemPriceWebhookEvent, executionId, error) {
    if (!LineItemPriceWebhookEvent || !executionId || !error) {
      return;
    }

    await LineItemPriceWebhookEvent.updateOne(
      { _id: executionId },
      {
        $set: {
          isSend: false,
          errorMessage: error.message,
        },
      }
    );
  },
};

export default lineItemPriceWebhookService;
