import axios from 'axios';
import https from 'https';
import logger from '../logger/logger.js';
import sapSessionManager, { isSessionInvalidError } from '../sap/sapSessionManager.js';
import { runWithRetry } from '../../shared/utils/retry.js';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const SAP_ITEM_PRICE_PATH = '/b1s/v2/CompanyService_GetItemPrice';
const SAP_ITEM_PRICES_SELECT_PATH = '/b1s/v2/Items';
const EXTERNAL_TIMEOUT_MS = 15000;

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
  return `${SAP_ITEM_PRICES_SELECT_PATH}('${encodeURIComponent(String(itemCode))}')?$select=ItemPrices,ItemWarehouseInfoCollection`;
}

function resolveBaseUrl(sapConfig) {
  const normalizedBaseUrl = String(sapConfig?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

  if (!normalizedBaseUrl) {
    throw new Error('SAP Service Layer base URL is required');
  }

  return normalizedBaseUrl;
}

export class SapLineItemPriceClient {
  async fetchBusinessPartnerPrice({
    sapConfig,
    cardCode,
    itemCode,
    date,
    tenantKey,
    requestPayload,
  }) {
    const url = `${resolveBaseUrl(sapConfig)}${SAP_ITEM_PRICE_PATH}`;
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

  async fetchItemPrices({ sapConfig, itemCode, tenantKey }) {
    const endpoint = buildSapItemPricesPath(itemCode);
    const url = `${resolveBaseUrl(sapConfig)}${endpoint}`;

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
}

export default SapLineItemPriceClient;
