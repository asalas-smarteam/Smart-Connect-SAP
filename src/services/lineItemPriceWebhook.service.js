import hubspotAuthService from './hubspotAuthService.js';
import * as hubspotClient from './hubspotClient.js';

const SUPPORTED_ASSOCIATION_TYPE = 'DEAL_TO_LINE_ITEM';
const SUPPORTED_CHANGE_SOURCE = 'USER';

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

  if (companyIds.length > 0) {
    const company = await fetchHubspotObject(token, 'companies', companyIds[0], {
      properties: ['idsap', 'idSap'],
    });
    const cardCode = resolveObjectIdSap(company);

    if (!cardCode) {
      throw new Error('Company idSap is required for the associated deal');
    }

    return cardCode;
  }

  if (contactIds.length > 0) {
    const contact = await fetchHubspotObject(token, 'contacts', contactIds[0], {
      properties: ['idsap', 'idSap'],
    });
    const cardCode = resolveObjectIdSap(contact);

    if (!cardCode) {
      throw new Error('Contact idSap is required for the associated deal');
    }

    return cardCode;
  }

  throw new Error('Associated company or contact is required for the deal');
}

async function resolveLineItems(token, deal) {
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
    lineItemIds.map(async (lineItemId, index) => {
      const lineItem = await fetchHubspotObject(token, 'line_items', lineItemId, {
        properties: ['hs_sku'],
      });
      const itemCode = toNonEmptyString(lineItem?.properties?.hs_sku || lineItem?.properties?.itemCode);

      if (!itemCode) {
        throw new Error(`lineItems[${index}].itemCode is required`);
      }

      return {
        id: toNonEmptyString(lineItem?.id) || lineItemId,
        itemCode,
      };
    })
  );

  return lineItems;
}

async function buildLegacyPayload(payload, token) {
  const dealId = toNonEmptyString(payload?.fromObjectId);

  if (!dealId) {
    throw new Error('fromObjectId is required');
  }

  const deal = await fetchHubspotObject(token, 'deals', dealId, {
    associations: ['companies', 'contacts', 'line_items'],
  });

  return {
    cardCode: await resolveCardCode(token, deal),
    lineItems: await resolveLineItems(token, deal),
  };
}

const lineItemPriceWebhookService = {
  isLegacyPayload,

  async preparePayload(payload, { tenantModels, tenant }) {
    if (isLegacyPayload(payload)) {
      return {
        skip: false,
        payload,
        executionId: null,
      };
    }

    if (
      payload?.associationType !== SUPPORTED_ASSOCIATION_TYPE
      || payload?.changeSource !== SUPPORTED_CHANGE_SOURCE
    ) {
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

      return {
        skip: false,
        payload: await buildLegacyPayload(payload, token),
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
