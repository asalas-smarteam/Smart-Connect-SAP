import logger from '../logger/logger.js';
import sapSessionManager, { isSessionInvalidError } from '../sap/sapSessionManager.js';
import { paginateODataCollection } from '../sap/transport/B1ServiceLayerTransport.js';
import { runWithRetry } from '#shared/utils/retry.js';

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

      // Session and retry stay here (this endpoint retries with a delay, unlike
      // the transport's retry-once-on-invalid-session); only the nextLink walk
      // is shared.
      const { items: discountGroups } = await paginateODataCollection({
        rootUrl: baseUrl,
        initialUrl,
        headers: {
          Cookie: cookie,
          Prefer: `odata.maxpagesize=${PAGE_SIZE}`,
        },
        timeout: EXTERNAL_TIMEOUT_MS,
        onPage: ({ page, pageCount, totalSoFar }) => logger.info({
          msg: 'SAP discount groups page retrieved',
          tenantKey,
          page,
          pageCount,
          totalSoFar,
        }),
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
