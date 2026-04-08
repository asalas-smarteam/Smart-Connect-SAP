import axios from 'axios';
import https from 'https';
import logger from '../core/logger.js';
import hubspotAuthService from './hubspotAuthService.js';
import * as hubspotClient from './hubspotClient.js';
import sapSessionManager, { isSessionInvalidError } from './sapSessionManager.js';
import { runWithRetry } from '../utils/retry.js';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const SAP_ITEM_PRICE_PATH = '/b1s/v2/CompanyService_GetItemPrice';
const EXTERNAL_TIMEOUT_MS = 15000;

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function formatCurrentDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function validatePayload(payload = {}) {
  if (!toNonEmptyString(payload.cardCode)) {
    throw new Error('cardCode is required');
  }

  if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
    throw new Error('lineItems must be a non-empty array');
  }

  payload.lineItems.forEach((lineItem, index) => {
    if (!toNonEmptyString(lineItem?.itemCode)) {
      throw new Error(`lineItems[${index}].itemCode is required`);
    }

    if (!toNonEmptyString(lineItem?.id)) {
      throw new Error(`lineItems[${index}].id is required`);
    }
  });
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

async function resolveSapCredentials(tenantModels, hubspotCredentials) {
  const { SapCredentials } = tenantModels;

  if (hubspotCredentials?.clientConfigId) {
    const byClientConfig = await SapCredentials.findOne({
      clientConfigId: hubspotCredentials.clientConfigId,
    });

    if (byClientConfig) {
      return byClientConfig;
    }
  }

  const credentials = await SapCredentials.findOne({});
  if (!credentials) {
    throw new Error('SAP Service Layer credentials not found for tenant');
  }

  return credentials;
}

function buildSapPricePayload({ cardCode, itemCode, date }) {
  return {
    ItemPriceParams: {
      ItemCode: itemCode,
      CardCode: cardCode,
      Date: date,
    },
  };
}

async function requestSapItemPrice({ sapConfig, cardCode, itemCode, date, tenantKey }) {
  const normalizedBaseUrl = String(sapConfig?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

  if (!normalizedBaseUrl) {
    throw new Error('SAP Service Layer base URL is required');
  }

  const url = `${normalizedBaseUrl}${SAP_ITEM_PRICE_PATH}`;
  const data = buildSapPricePayload({ cardCode, itemCode, date });

  const makeRequest = async () => {
    const { cookie } = await sapSessionManager.getSessionCookie(sapConfig);

    logger.info({
      msg: 'Requesting SAP item price',
      tenantKey,
      endpoint: SAP_ITEM_PRICE_PATH,
      cardCode,
      itemCode,
    });

    const response = await axios.post(url, data, {
      httpsAgent,
      timeout: EXTERNAL_TIMEOUT_MS,
      headers: {
        Cookie: cookie,
      },
    });

    logger.info({
      msg: 'SAP item price retrieved',
      tenantKey,
      endpoint: SAP_ITEM_PRICE_PATH,
      cardCode,
      itemCode,
      price: response?.data?.Price ?? null,
      currency: response?.data?.Currency ?? null,
      discount: response?.data?.Discount ?? null,
    });

    return response.data;
  };

  return runWithRetry(makeRequest, {
    retries: 1,
    delayMs: 500,
    onError: async (error, attempt) => {
      logger.warn({
        msg: 'SAP item price request failed',
        tenantKey,
        endpoint: SAP_ITEM_PRICE_PATH,
        cardCode,
        itemCode,
        attempt: attempt + 1,
        error: error.message,
        status: error?.response?.status ?? null,
      });

      if (isSessionInvalidError(error)) {
        await sapSessionManager.invalidateSession(
          sapSessionManager.resolveTenantKey(sapConfig)
        );
      }
    },
  });
}

function buildHubspotBatchPayload(enrichedLineItems) {
  return {
    inputs: enrichedLineItems.map((lineItem) => ({
      id: String(lineItem.id),
      properties: {
        price: String(lineItem.Price ?? 0),
      },
    })),
  };
}

async function updateHubspotLineItems({ token, enrichedLineItems, tenantKey }) {
  const batchPayload = buildHubspotBatchPayload(enrichedLineItems);

  logger.info({
    msg: 'Updating HubSpot line items with SAP prices',
    tenantKey,
    count: batchPayload.inputs.length,
  });

  const response = await runWithRetry(
    () => hubspotClient.batchUpdateLineItems(token, batchPayload),
    {
      retries: 1,
      delayMs: 500,
      onError: async (error, attempt) => {
        logger.warn({
          msg: 'HubSpot line item batch update failed',
          tenantKey,
          count: batchPayload.inputs.length,
          attempt: attempt + 1,
          error: error.message,
          status: error?.details?.status ?? error?.response?.status ?? null,
        });
      },
    }
  );

  logger.info({
    msg: 'HubSpot line items updated with SAP prices',
    tenantKey,
    count: batchPayload.inputs.length,
    updatedCount: Array.isArray(response?.results)
      ? response.results.length
      : batchPayload.inputs.length,
  });

  return {
    payload: batchPayload,
    response,
  };
}

const lineItemPriceService = {
  async syncPrices(payload, { tenantModels, tenant, tenantKey }) {
    validatePayload(payload);

    const cardCode = toNonEmptyString(payload.cardCode);
    const currentDate = formatCurrentDate();
    const hubspotCredentials = await resolveHubspotCredentials(tenantModels, tenant);
    const sapCredentials = await resolveSapCredentials(tenantModels, hubspotCredentials);
    const sapCredentialsData = typeof sapCredentials?.toObject === 'function'
      ? sapCredentials.toObject()
      : sapCredentials;
    const sapConfig = {
      ...sapCredentialsData,
      tenantKey,
    };

    const enrichedLineItems = [];

    for (const lineItem of payload.lineItems) {
      const itemCode = toNonEmptyString(lineItem.itemCode);
      const id = toNonEmptyString(lineItem.id);
      const priceData = await requestSapItemPrice({
        sapConfig,
        cardCode,
        itemCode,
        date: currentDate,
        tenantKey,
      });

      enrichedLineItems.push({
        itemCode,
        id,
        Price: priceData?.Price ?? 0,
        Currency: priceData?.Currency ?? null,
        Discount: priceData?.Discount ?? 0,
      });
    }

    const token = await hubspotAuthService.getAccessToken(
      hubspotCredentials.clientConfigId,
      hubspotCredentials,
      tenantModels
    );

    const hubspotUpdate = await updateHubspotLineItems({
      token,
      enrichedLineItems,
      tenantKey,
    });

    return {
      data: {
        cardCode,
        lineItems: enrichedLineItems,
      },
      meta: {
        requestedCount: hubspotUpdate.payload.inputs.length,
        updatedCount: Array.isArray(hubspotUpdate.response?.results)
          ? hubspotUpdate.response.results.length
          : hubspotUpdate.payload.inputs.length,
      },
    };
  },
};

export default lineItemPriceService;
