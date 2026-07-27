import axios from 'axios';
import https from 'https';
import logger from '../../logger/logger.js';
import sapSessionManager, { isSessionInvalidError } from '../sapSessionManager.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const B1_BASE_PATH = '/b1s/v2';
const DEFAULT_PAGE_SIZE_HEADER = 'odata.maxpagesize=100';

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildQueryString(query = {}) {
  // Values are passed through untouched: callers pre-encode OData options
  // (same contract as the existing serviceLayerUrlBuilder).
  return Object.entries(query)
    .filter(([, value]) => value !== null && typeof value !== 'undefined')
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

// Transport for SAP Business One Service Layer (OData v4 dialect).
// Session handling (login, Redis-cached cookie, distributed lock) stays in
// sapSessionManager; this class only concerns itself with URLs, pagination
// and the retry-once-on-invalid-session policy the existing services use.
export class B1ServiceLayerTransport {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.baseUrl = cleanBaseUrl(config.serviceLayerBaseUrl);

    if (!this.baseUrl) {
      throw new Error('serviceLayerBaseUrl is required for B1 Service Layer transport');
    }
  }

  buildUrl(path, query) {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath) {
      throw new Error('path is required');
    }

    const withPrefix = `${B1_BASE_PATH}${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}`;
    const queryString = buildQueryString(query);
    return `${this.baseUrl}${withPrefix}${queryString ? `?${queryString}` : ''}`;
  }

  normalizeNextLink(nextLink) {
    if (!nextLink) {
      return null;
    }

    if (/^https?:\/\//i.test(nextLink)) {
      return nextLink;
    }

    if (nextLink.startsWith(B1_BASE_PATH)) {
      return `${this.baseUrl}${nextLink}`;
    }

    return `${this.baseUrl}${B1_BASE_PATH}${nextLink.startsWith('/') ? '' : '/'}${nextLink}`;
  }

  async withSession(operation) {
    const attempt = async () => {
      const { cookie } = await sapSessionManager.getSessionCookie(this.config);
      return operation(cookie);
    };

    try {
      return await attempt();
    } catch (error) {
      if (!isSessionInvalidError(error)) {
        throw error;
      }

      const tenantKey = sapSessionManager.resolveTenantKey(this.config);
      logger.warn('Invalid B1 session in transport, invalidating and retrying once', {
        tenantKey,
        error: error.message,
      });

      await sapSessionManager.invalidateSession(tenantKey);
      return attempt();
    }
  }

  async request({ method = 'get', path, query, headers, body } = {}) {
    const url = this.buildUrl(path, query);

    return this.withSession(async (cookie) => {
      const response = await axios({
        method: String(method || 'get').toLowerCase(),
        url,
        data: body,
        headers: {
          Cookie: cookie,
          ...(headers || {}),
        },
        httpsAgent,
      });

      const data = response?.data;
      // Collections arrive as { value: [...] }; single entities as plain
      // objects. request() does not paginate — that is fetchAll's job.
      return Array.isArray(data?.value) ? data.value : data;
    });
  }

  async fetchAll({ path, query, headers } = {}) {
    const initialUrl = this.buildUrl(path, query);

    // The whole pagination run shares one session cookie; an invalid-session
    // error restarts it once from the beginning (same policy as the existing
    // serviceLayer.service flow).
    return this.withSession(async (cookie) => {
      const items = [];
      let nextUrl = initialUrl;

      while (nextUrl) {
        // eslint-disable-next-line no-await-in-loop
        const response = await axios.get(nextUrl, {
          headers: {
            Cookie: cookie,
            Prefer: DEFAULT_PAGE_SIZE_HEADER,
            ...(headers || {}),
          },
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

        nextUrl = this.normalizeNextLink(data?.['@odata.nextLink']);
      }

      return items;
    });
  }
}

export default B1ServiceLayerTransport;
