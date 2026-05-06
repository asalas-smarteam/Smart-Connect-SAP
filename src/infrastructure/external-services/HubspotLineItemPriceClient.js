import logger from '../../core/logger.js';
import hubspotAuthService from '../../services/hubspotAuthService.js';
import * as hubspotClient from '../../services/hubspotClient.js';
import { runWithRetry } from '../../utils/retry.js';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
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

function buildHubspotBatchPayload(enrichedLineItems) {
  return {
    inputs: enrichedLineItems.map((lineItem) => ({
      id: String(lineItem.id),
      properties: {
        price: String(roundCurrency(lineItem.Price ?? 0)),
        quantity: String(normalizeQuantity(lineItem.quantity ?? lineItem.Quantity)),
        ...(lineItem.warehouseStockProperties || {}),
      },
    })),
  };
}

function buildHubspotProductBatchPayload(enrichedLineItems, productsBySku) {
  return {
    inputs: enrichedLineItems
      .filter((lineItem, index, items) => items.findIndex((item) => item.itemCode === lineItem.itemCode) === index)
      .map((lineItem) => {
        const productId = productsBySku.get(lineItem.itemCode);
        if (!productId) {
          return null;
        }

        return {
          id: String(productId),
          properties: {
            ...(lineItem.warehouseStockProperties || {}),
          },
        };
      })
      .filter(Boolean),
  };
}

function buildHubspotDealPayload(totalAmount) {
  return {
    properties: {
      amount: String(roundCurrency(totalAmount)),
    },
  };
}

async function findHubspotProductBySku({ token, sku, tenantKey }) {
  return runWithRetry(
    () => hubspotClient.findProductBySKU(token, sku),
    {
      retries: 1,
      delayMs: 500,
      onError: async (error, attempt) => {
        logger.warn({
          msg: 'HubSpot product search by SKU failed',
          tenantKey,
          sku,
          attempt: attempt + 1,
          error: error.message,
          status: error?.details?.status ?? error?.response?.status ?? null,
        });
      },
    }
  );
}

export class HubspotLineItemPriceClient {
  async getAccessToken({ hubspotCredentials, tenantModels }) {
    return hubspotAuthService.getAccessToken(
      hubspotCredentials.clientConfigId,
      hubspotCredentials,
      tenantModels
    );
  }

  async updateLineItems({ token, enrichedLineItems, tenantKey }) {
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

  async updateProducts({ token, enrichedLineItems, tenantKey }) {
    const uniqueItemCodes = enrichedLineItems
      .map((lineItem) => lineItem.itemCode)
      .filter(Boolean)
      .filter((itemCode, index, items) => items.indexOf(itemCode) === index);
    const productsBySku = new Map();

    for (const itemCode of uniqueItemCodes) {
      // Sequential search avoids burst rate-limit against HubSpot search API.
      // eslint-disable-next-line no-await-in-loop
      const product = await findHubspotProductBySku({
        token,
        sku: itemCode,
        tenantKey,
      });

      const productId = toNonEmptyString(product?.id);
      if (productId) {
        productsBySku.set(itemCode, productId);
      }
    }

    const batchPayload = buildHubspotProductBatchPayload(enrichedLineItems, productsBySku);

    if (batchPayload.inputs.length === 0) {
      logger.info({
        msg: 'No HubSpot products found to update stock',
        tenantKey,
        requestedCount: uniqueItemCodes.length,
      });

      return {
        payload: batchPayload,
        response: { results: [] },
      };
    }

    logger.info({
      msg: 'Updating HubSpot products with SAP stock',
      tenantKey,
      count: batchPayload.inputs.length,
    });

    const response = await runWithRetry(
      () => hubspotClient.batchUpdateProducts(token, batchPayload),
      {
        retries: 1,
        delayMs: 500,
        onError: async (error, attempt) => {
          logger.warn({
            msg: 'HubSpot product batch update failed',
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
      msg: 'HubSpot products updated with SAP stock',
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

  async updateDealAmount({ token, dealId, totalAmount, tenantKey }) {
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
}

export default HubspotLineItemPriceClient;
