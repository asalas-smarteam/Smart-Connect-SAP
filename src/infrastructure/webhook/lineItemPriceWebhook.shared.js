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

