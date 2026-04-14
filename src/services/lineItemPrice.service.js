import axios from 'axios';
import https from 'https';
import logger from '../core/logger.js';
import hubspotAuthService from './hubspotAuthService.js';
import * as hubspotClient from './hubspotClient.js';
import sapSessionManager, { isSessionInvalidError } from './sapSessionManager.js';
import tenantConfigurationService from './tenantConfiguration.service.js';
import { runWithRetry } from '../utils/retry.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from './syncLog.service.js';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const SAP_ITEM_PRICE_PATH = '/b1s/v2/CompanyService_GetItemPrice';
const SAP_ITEM_PRICES_SELECT_PATH = '/b1s/v2/Items';
const EXTERNAL_TIMEOUT_MS = 15000;
const DEFAULT_PRICE_LIST = '4';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function formatCurrentDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function normalizeNumber(value, fallback = 0) {
  const normalized = Number(String(value ?? '').trim());
  return Number.isFinite(normalized) ? normalized : fallback;
}

function normalizeQuantity(value) {
  const normalized = normalizeNumber(value, 0);
  return normalized > 0 ? normalized : 1;
}

function roundCurrency(value) {
  return Math.round((normalizeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function validatePayload(payload = {}) {
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

function buildSapItemPricesPath(itemCode) {
  return `${SAP_ITEM_PRICES_SELECT_PATH}('${encodeURIComponent(String(itemCode))}')?$select=ItemPrices`;
}

function normalizePriceList(value) {
  const normalized = Number(String(value ?? '').trim());
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

async function resolveTenantPriceList(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    'priceList',
    DEFAULT_PRICE_LIST
  );
  const priceList = normalizePriceList(value);

  if (!priceList) {
    throw new Error('Configuration priceList must be a positive integer');
  }

  return priceList;
}

async function requestSapItemPrice({
  sapConfig,
  cardCode,
  itemCode,
  date,
  tenantKey,
  requestPayload,
}) {
  const normalizedBaseUrl = String(sapConfig?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

  if (!normalizedBaseUrl) {
    throw new Error('SAP Service Layer base URL is required');
  }

  const url = `${normalizedBaseUrl}${SAP_ITEM_PRICE_PATH}`;
  const data = requestPayload || buildSapPricePayload({ cardCode, itemCode, date });

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

async function requestSapItemPrices({
  sapConfig,
  itemCode,
  tenantKey,
}) {
  const normalizedBaseUrl = String(sapConfig?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

  if (!normalizedBaseUrl) {
    throw new Error('SAP Service Layer base URL is required');
  }

  const endpoint = buildSapItemPricesPath(itemCode);
  const url = `${normalizedBaseUrl}${endpoint}`;

  const makeRequest = async () => {
    const { cookie } = await sapSessionManager.getSessionCookie(sapConfig);

    logger.info({
      msg: 'Requesting SAP item prices by price list',
      tenantKey,
      endpoint,
      itemCode,
    });

    const response = await axios.get(url, {
      httpsAgent,
      timeout: EXTERNAL_TIMEOUT_MS,
      headers: {
        Cookie: cookie,
      },
    });

    logger.info({
      msg: 'SAP item prices retrieved',
      tenantKey,
      endpoint,
      itemCode,
      priceListCount: Array.isArray(response?.data?.ItemPrices)
        ? response.data.ItemPrices.length
        : 0,
    });

    return response.data;
  };

  return runWithRetry(makeRequest, {
    retries: 1,
    delayMs: 500,
    onError: async (error, attempt) => {
      logger.warn({
        msg: 'SAP item prices request failed',
        tenantKey,
        endpoint,
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

function selectConfiguredItemPrice(itemPrices, priceList, itemCode) {
  const selectedPrice = Array.isArray(itemPrices)
    ? itemPrices.find((itemPrice) => Number(itemPrice?.PriceList) === priceList)
    : null;

  if (!selectedPrice) {
    throw new Error(`Price list ${priceList} not found for item ${itemCode}`);
  }

  return selectedPrice;
}

function buildHubspotBatchPayload(enrichedLineItems) {
  return {
    inputs: enrichedLineItems.map((lineItem) => ({
      id: String(lineItem.id),
      properties: {
        price: String(roundCurrency(lineItem.Price ?? 0)),
        quantity: String(normalizeQuantity(lineItem.quantity ?? lineItem.Quantity)),
      },
    })),
  };
}

function buildHubspotDealPayload(totalAmount) {
  return {
    properties: {
      amount: String(roundCurrency(totalAmount)),
    },
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

async function updateHubspotDealAmount({ token, dealId, totalAmount, tenantKey }) {
  const dealPayload = buildHubspotDealPayload(totalAmount);

  logger.info({
    msg: 'Updating HubSpot deal total from SAP prices',
    tenantKey,
    dealId,
    totalAmount: roundCurrency(totalAmount),
  });

  const response = await runWithRetry(
    () => hubspotClient.updateDeal(token, dealId, dealPayload),
    {
      retries: 1,
      delayMs: 500,
      onError: async (error, attempt) => {
        logger.warn({
          msg: 'HubSpot deal total update failed',
          tenantKey,
          dealId,
          totalAmount: roundCurrency(totalAmount),
          attempt: attempt + 1,
          error: error.message,
          status: error?.details?.status ?? error?.response?.status ?? null,
        });
      },
    }
  );

  logger.info({
    msg: 'HubSpot deal total updated from SAP prices',
    tenantKey,
    dealId,
    totalAmount: roundCurrency(totalAmount),
  });

  return {
    payload: dealPayload,
    response,
  };
}

const lineItemPriceService = {
  async syncPrices(payload, { tenantModels, tenant, tenantKey }) {
    const auditTrail = {
      payload_Hubspot: payload,
      payload_SAP: [],
      response_hubspot: null,
      response_SAP: [],
    };

    try {
      validatePayload(payload);

      const cardCode = toNonEmptyString(payload.cardCode);
      const dealId = toNonEmptyString(payload.dealId) || toNonEmptyString(payload.fromObjectId);
      const useBusinessPartnerPrice = Boolean(cardCode);
      const currentDate = formatCurrentDate();
      const hubspotCredentials = await resolveHubspotCredentials(tenantModels, tenant);
      const sapCredentials = await resolveSapCredentials(tenantModels, hubspotCredentials);
      const fallbackPriceList = useBusinessPartnerPrice
        ? null
        : await resolveTenantPriceList(tenantModels);
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
        let priceData;

        if (useBusinessPartnerPrice) {
          const sapRequestPayload = buildSapPricePayload({
            cardCode,
            itemCode,
            date: currentDate,
          });

          auditTrail.payload_SAP.push(sapRequestPayload);

          priceData = await requestSapItemPrice({
            sapConfig,
            cardCode,
            itemCode,
            date: currentDate,
            tenantKey,
            requestPayload: sapRequestPayload,
          });
        } else {
          const sapRequestPayload = {
            method: 'GET',
            endpoint: buildSapItemPricesPath(itemCode),
            priceList: fallbackPriceList,
          };

          auditTrail.payload_SAP.push(sapRequestPayload);

          const sapItemData = await requestSapItemPrices({
            sapConfig,
            itemCode,
            tenantKey,
          });
          const selectedPrice = selectConfiguredItemPrice(
            sapItemData?.ItemPrices,
            fallbackPriceList,
            itemCode
          );

          priceData = {
            Price: selectedPrice?.Price ?? 0,
            Currency: selectedPrice?.Currency ?? null,
            Discount: 0,
            PriceList: selectedPrice?.PriceList ?? fallbackPriceList,
          };

          auditTrail.response_SAP.push({
            ...sapItemData,
            selectedPrice,
          });
        }

        if (useBusinessPartnerPrice) {
          auditTrail.response_SAP.push(priceData);
        }

        const quantity = normalizeQuantity(lineItem.quantity ?? lineItem.Quantity);
        const price = roundCurrency(priceData?.Price ?? 0);
        const lineTotal = roundCurrency(quantity * price);

        enrichedLineItems.push({
          itemCode,
          id,
          quantity,
          Price: price,
          Currency: priceData?.Currency ?? null,
          Discount: priceData?.Discount ?? 0,
          lineTotal,
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

      auditTrail.response_hubspot = {
        lineItems: {
          payload: hubspotUpdate.payload,
          response: hubspotUpdate.response,
        },
      };

      let dealUpdate = null;
      const totalAmount = roundCurrency(
        enrichedLineItems.reduce((sum, lineItem) => sum + lineItem.lineTotal, 0)
      );

      if (dealId) {
        dealUpdate = await updateHubspotDealAmount({
          token,
          dealId,
          totalAmount,
          tenantKey,
        });

        auditTrail.response_hubspot.deal = {
          payload: dealUpdate.payload,
          response: dealUpdate.response,
        };
      }

      return {
        data: {
          cardCode,
          dealId,
          totalAmount,
          lineItems: enrichedLineItems,
        },
        meta: {
          requestedCount: hubspotUpdate.payload.inputs.length,
          updatedCount: Array.isArray(hubspotUpdate.response?.results)
            ? hubspotUpdate.response.results.length
            : hubspotUpdate.payload.inputs.length,
          dealUpdated: Boolean(dealUpdate),
        },
      };
    } catch (error) {
      const errorSnapshot = buildErrorResponseSnapshot(error);
      const message = String(error?.message || '').toLowerCase();
      const responseHubspot = message.includes('hubspot')
        ? {
          ...(auditTrail.response_hubspot || {}),
          error: errorSnapshot,
        }
        : auditTrail.response_hubspot;
      const responseSap = auditTrail.response_SAP.length > 0
        ? [...auditTrail.response_SAP]
        : [];

      if (!responseHubspot && !message.includes('hubspot') && errorSnapshot) {
        responseSap.push(errorSnapshot);
      }

      error.syncLogWebhookErrors = [
        buildWebhookSyncErrorEntry({
          payloadHubspot: auditTrail.payload_Hubspot,
          payloadSap: auditTrail.payload_SAP,
          responseHubspot,
          responseSap,
        }),
      ];

      throw error;
    }
  },
};

export default lineItemPriceService;
