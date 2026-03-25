import axios from 'axios';
import https from 'https';
import { buildServiceLayerUrl } from './serviceLayerUrlBuilder.js';
import logger from '../core/logger.js';
import sapSessionManager, { isSessionInvalidError } from './sapSessionManager.js';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

function normalizeNextLink(baseUrl, nextLink) {
  if (!nextLink) {
    return null;
  }

  if (/^https?:\/\//i.test(nextLink)) {
    return nextLink;
  }

  return `${baseUrl}${nextLink.startsWith('/') ? '' : '/'}${nextLink}`;
}


function withTopParam(url, top) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('$top')) {
    parsed.searchParams.set('$top', String(top));
  }
  return parsed.toString();
}

async function fetchAllPages(baseUrl, initialUrl, headers) {
  const items = [];
  let nextUrl = initialUrl;

  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      headers,
      httpsAgent,
    });

    const data = response?.data;
    if (Array.isArray(data?.value)) {
      items.push(...data.value);
    } else if (Array.isArray(data)) {
      items.push(...data);
    } else if (data) {
      items.push(data);
    }

    nextUrl = normalizeNextLink(baseUrl + '/b1s/v2' , data?.['@odata.nextLink']);
  }

  return items;
}

const serviceLayerService = {
  async execute(config, mappings, options = {}) {
    const baseUrl = String(config?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

    if (!baseUrl) {
      throw new Error('serviceLayerBaseUrl is required for SERVICE_LAYER mode');
    }

    /*if (!options?.controlledFilter && config?.intervalMinutes && config.intervalMinutes > 0) {
      const now = new Date();
      const past = new Date(now.getTime() - config.intervalMinutes * 60000);
      const formatted = past.toISOString().split('.')[0];
      options.controlledFilter = `UpdateDate ge 2026-01-01`; // ${formatted}
    }*/

    const requestOptions = {
      ...options,
      top: options?.top || config?.serviceLayerTopFilter || 20,
    };

    const dataUrl = withTopParam(buildServiceLayerUrl(config, mappings, requestOptions), requestOptions.top);

    const requestWithSession = async () => {
      const { cookie } = await sapSessionManager.getSessionCookie(config);
      return fetchAllPages(baseUrl, dataUrl, { Cookie: cookie });
    };

    try {
      return await requestWithSession();
    } catch (error) {
      if (!isSessionInvalidError(error)) {
        throw error;
      }

      const tenantKey = sapSessionManager.resolveTenantKey(config);
      logger.warn('Invalid SAP session, invalidating and retrying once', {
        tenantKey,
        error: error.message,
      });

      await sapSessionManager.invalidateSession(tenantKey);
      return requestWithSession();
    }
  },
};

export default serviceLayerService;
