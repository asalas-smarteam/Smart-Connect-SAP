import * as hubspotClient from '../hubspot/hubspotClient.js';
import {
  extractAssociationIds,
  extractLineItemAssociationIds,
} from '#shared/utils/hubspot-associations.utils.js';

// Helpers compartidos por las strategies del webhook de precios de line items
// (businessPartner legacy y dealPriceList). Extraídos de lineItemPriceWebhook.service.js
// sin cambios de comportamiento.

export { extractAssociationIds, extractLineItemAssociationIds };

export function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildDuplicateFilter(payload = {}) {
  return {
    'payload.eventId': payload.eventId,
    'payload.subscriptionId': payload.subscriptionId,
    'payload.portalId': payload.portalId,
    'payload.appId': payload.appId,
    'payload.occurredAt': payload.occurredAt,
    'payload.fromObjectId': payload.fromObjectId,
  };
}

export function assertRequiredWebhookField(payload, fieldName) {
  if (payload?.[fieldName] === undefined || payload?.[fieldName] === null || payload?.[fieldName] === '') {
    throw new Error(`${fieldName} is required`);
  }
}

export async function resolveHubspotCredentials(tenantModels, tenant) {
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

export async function fetchHubspotObject(token, objectType, objectId, { properties = [], associations = [] } = {}) {
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

// Lector tolerante: NUNCA lanza por una línea individual. Sigue usando Promise.all porque el
// paralelismo no es el problema; el problema era que un solo rechazo mataba al conjunto y
// dejaba sin precio a todas las demás líneas del deal.
export async function readLineItems({
  token,
  lineItemIds = [],
  extraProperties = [],
  fetch = fetchHubspotObject,
} = {}) {
  const normalizedExtras = extraProperties.filter(Boolean);
  const properties = ['hs_sku', 'quantity', ...normalizedExtras]
    .filter((value, index, values) => value && values.indexOf(value) === index);

  const results = await Promise.all(lineItemIds.map(async (lineItemId) => {
    const id = String(lineItemId);

    try {
      const record = await fetch(token, 'line_items', lineItemId, { properties });
      const itemCode = toNonEmptyString(
        record?.properties?.hs_sku || record?.properties?.itemCode
      );

      if (!itemCode) {
        return {
          failure: {
            id,
            stage: 'hubspot_read',
            reason: 'line item has no hs_sku',
            status: null,
            endpoint: null,
          },
        };
      }

      const recordProperties = record?.properties ?? {};

      return {
        lineItem: {
          id: toNonEmptyString(record?.id) || id,
          itemCode,
          quantity: recordProperties.quantity ?? null,
          properties: recordProperties,
          ...Object.fromEntries(
            normalizedExtras.map((name) => [name, recordProperties[name] ?? null])
          ),
        },
      };
    } catch (error) {
      return {
        failure: {
          id,
          stage: 'hubspot_read',
          reason: error.message,
          status: error?.details?.status ?? error?.response?.status ?? null,
          endpoint: error?.details?.endpoint ?? null,
        },
      };
    }
  }));

  return {
    lineItems: results.map((entry) => entry.lineItem).filter(Boolean),
    failures: results.map((entry) => entry.failure).filter(Boolean),
  };
}

// Lectura del deal: SÍ lanza. Sin el deal no hay nada que valorizar, así que es fatal y
// HubSpot debe reintentar en vez de que el evento se marque como bueno sin haber hecho nada.
export async function readDealLineItemIds({ token, dealId, fetch = fetchHubspotObject } = {}) {
  const deal = await fetch(token, 'deals', dealId, { associations: ['line_items'] });

  return extractLineItemAssociationIds(deal);
}

