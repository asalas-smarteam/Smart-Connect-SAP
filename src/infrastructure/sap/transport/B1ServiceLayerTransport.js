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

// `rootUrl` is the Service Layer host without /b1s/v2. B1 answers with three
// shapes depending on the endpoint: an absolute URL, a path already carrying
// /b1s/v2, or just the entity set plus the original query options.
export function normalizeODataNextLink(rootUrl, nextLink) {
  if (!nextLink) {
    return null;
  }

  if (/^https?:\/\//i.test(nextLink)) {
    return nextLink;
  }

  if (nextLink.startsWith(B1_BASE_PATH)) {
    return `${rootUrl}${nextLink}`;
  }

  return `${rootUrl}${B1_BASE_PATH}${nextLink.startsWith('/') ? '' : '/'}${nextLink}`;
}

// The single @odata.nextLink walker. Everything that reads a B1 collection goes
// through here, so pagination cannot silently differ between callers -- session
// handling and retry policy stay with each caller, which is where they legitimately
// differ.
export async function paginateODataCollection({
  rootUrl,
  initialUrl,
  headers,
  timeout,
  onPage,
} = {}) {
  const items = [];
  let nextUrl = initialUrl;
  let pages = 0;

  while (nextUrl) {
    pages += 1;

    // eslint-disable-next-line no-await-in-loop
    const response = await axios.get(nextUrl, {
      headers,
      httpsAgent,
      ...(timeout ? { timeout } : {}),
    });

    const data = response?.data;
    let pageItems = [];

    if (Array.isArray(data?.value)) {
      pageItems = data.value;
    } else if (Array.isArray(data)) {
      pageItems = data;
    } else if (data) {
      pageItems = [data];
    }

    items.push(...pageItems);
    onPage?.({ page: pages, pageCount: pageItems.length, totalSoFar: items.length });

    nextUrl = normalizeODataNextLink(rootUrl, data?.['@odata.nextLink']);
  }

  return { items, pages };
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
    return normalizeODataNextLink(this.baseUrl, nextLink);
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

  // `url` takes an already-built absolute URL, for callers that assemble their
  // own OData query (serviceLayerUrlBuilder, the discount groups endpoint).
  async fetchAll({ path, query, headers, url, timeout } = {}) {
    const initialUrl = url || this.buildUrl(path, query);

    // The whole pagination run shares one session cookie; an invalid-session
    // error restarts it once from the beginning.
    return this.withSession(async (cookie) => {
      const { items, pages } = await paginateODataCollection({
        rootUrl: this.baseUrl,
        initialUrl,
        headers: {
          Cookie: cookie,
          Prefer: DEFAULT_PAGE_SIZE_HEADER,
          ...(headers || {}),
        },
        timeout,
      });

      // B1 pages collections at 20 rows by default (the Prefer header above
      // raises it to 100). When a caller ends up with fewer rows than SAP holds,
      // the first thing worth knowing is whether the nextLink chain was followed
      // at all or the read stopped on page one -- so the page count is logged.
      logger.info('B1 Service Layer collection fetched', {
        tenantKey: sapSessionManager.resolveTenantKey(this.config),
        path: path ?? initialUrl,
        pages,
        rowCount: items.length,
      });

      return items;
    });
  }
}

export default B1ServiceLayerTransport;
