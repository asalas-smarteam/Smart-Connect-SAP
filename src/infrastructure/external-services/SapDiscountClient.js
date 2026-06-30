import axios from 'axios';
import https from 'https';
import logger from '../logger/logger.js';
import sapSessionManager, { isSessionInvalidError } from '../sap/sapSessionManager.js';
import { runWithRetry } from '#shared/utils/retry.js';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const SAP_DISCOUNT_GROUPS_PATH = '/b1s/v2/EnhancedDiscountGroups';
const SAP_DISCOUNT_GROUPS_SELECT_FIELDS = ['AbsEntry', 'ObjectCode', 'ValidFrom', 'ValidTo', 'DiscountGroupLineCollection'];
const EXTERNAL_TIMEOUT_MS = 30000;
const PAGE_SIZE = 100;

function resolveBaseUrl(sapConfig) {
  const normalizedBaseUrl = String(sapConfig?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

  if (!normalizedBaseUrl) {
    throw new Error('SAP Service Layer base URL is required');
  }

  return normalizedBaseUrl;
}

function buildDiscountGroupsUrl(baseUrl) {
  const selectFields = SAP_DISCOUNT_GROUPS_SELECT_FIELDS.join(',');
  return `${baseUrl}${SAP_DISCOUNT_GROUPS_PATH}?$filter=${encodeURIComponent("Active eq 'tYES'")}&$select=${selectFields}`;
}

function normalizeNextLink(baseUrl, nextLink) {
  if (!nextLink) {
    return null;
  }

  if (/^https?:\/\//i.test(nextLink)) {
    return nextLink;
  }

  if (nextLink.startsWith('/b1s/v2')) {
    return `${baseUrl.replace(/\/b1s\/v2$/, '')}${nextLink}`;
  }

  return `${baseUrl}${nextLink.startsWith('/') ? '' : '/'}${nextLink}`;
}

async function fetchAllDiscountGroupPages({ baseUrl, initialUrl, headers, tenantKey }) {
  const discountGroups = [];
  let nextUrl = initialUrl;
  let page = 0;

  while (nextUrl) {
    page += 1;

    // eslint-disable-next-line no-await-in-loop
    const response = await axios.get(nextUrl, {
      httpsAgent,
      timeout: EXTERNAL_TIMEOUT_MS,
      headers,
    });

    const data = response?.data;
    if (Array.isArray(data?.value)) {
      discountGroups.push(...data.value);
    }

    logger.info({
      msg: 'SAP discount groups page retrieved',
      tenantKey,
      page,
      pageCount: Array.isArray(data?.value) ? data.value.length : 0,
      totalSoFar: discountGroups.length,
    });

    nextUrl = normalizeNextLink(`${baseUrl}/b1s/v2`, data?.['@odata.nextLink']);
  }

  return discountGroups;
}

export class SapDiscountClient {
  async fetchActiveDiscountGroups({ sapConfig, tenantKey }) {
    const baseUrl = resolveBaseUrl(sapConfig);
    const initialUrl = buildDiscountGroupsUrl(baseUrl);

    const makeRequest = async () => {
      const { cookie } = await sapSessionManager.getSessionCookie(sapConfig);

      logger.info({
        msg: 'Requesting SAP active discount groups',
        tenantKey,
        endpoint: SAP_DISCOUNT_GROUPS_PATH,
      });

      const discountGroups = await fetchAllDiscountGroupPages({
        baseUrl,
        initialUrl,
        headers: {
          Cookie: cookie,
          Prefer: `odata.maxpagesize=${PAGE_SIZE}`,
        },
        tenantKey,
      });

      logger.info({
        msg: 'SAP active discount groups retrieved',
        tenantKey,
        endpoint: SAP_DISCOUNT_GROUPS_PATH,
        count: discountGroups.length,
      });

      return discountGroups;
    };

    return runWithRetry(makeRequest, {
      retries: 1,
      delayMs: 500,
      onError: async (error, attempt) => {
        logger.warn({
          msg: 'SAP active discount groups request failed',
          tenantKey,
          endpoint: SAP_DISCOUNT_GROUPS_PATH,
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

export default SapDiscountClient;
