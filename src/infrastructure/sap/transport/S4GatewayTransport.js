import axios from 'axios';
import https from 'https';
import logger from '../../logger/logger.js';
import {
  extractODataV2NextLink,
  normalizeODataV2Response,
} from './odataV2Normalizer.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const DEFAULT_GATEWAY_BASE_PATH = '/sap/opu/odata/sap';
const DEFAULT_TIMEOUT_MS = 30000;
const UNSAFE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildQueryString(query = {}) {
  // Values are passed through untouched: callers pre-encode OData options
  // (same contract as the existing serviceLayerUrlBuilder).
  const entries = Object.entries(query).filter(
    ([, value]) => value !== null && typeof value !== 'undefined'
  );

  if (!entries.some(([key]) => key === '$format')) {
    // Gateway OData v2 answers Atom XML by default; JSON must be explicit.
    entries.push(['$format', 'json']);
  }

  return entries.map(([key, value]) => `${key}=${value}`).join('&');
}

function readCsrfCookie(response) {
  const setCookie = response?.headers?.['set-cookie'] || [];
  return setCookie
    .map((cookie) => String(cookie).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function isCsrfRejection(error) {
  return (
    error?.response?.status === 403
    && String(error?.response?.headers?.['x-csrf-token'] || '').toLowerCase() === 'required'
  );
}

// Transport for SAP S/4HANA Gateway (OData v2). Auth is HTTP basic on every
// request; writes additionally require a CSRF token fetched via a GET on the
// service document and its companion session cookie.
export class S4GatewayTransport {
  constructor({ config = {} } = {}) {
    this.baseUrl = cleanBaseUrl(config.serviceLayerBaseUrl);
    this.gatewayBasePath = cleanBaseUrl(config.gatewayBasePath) || DEFAULT_GATEWAY_BASE_PATH;
    this.auth = {
      username: String(config.serviceLayerUsername || '').trim(),
      password: String(config.serviceLayerPassword || '').trim(),
    };
    this.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.csrfState = null;

    if (!this.baseUrl) {
      throw new Error('serviceLayerBaseUrl is required for S4 Gateway transport');
    }
  }

  buildUrl(path, query) {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath) {
      throw new Error('path is required');
    }

    // Paths already rooted at /sap/ (e.g. the Gateway catalog service) are
    // used verbatim; entity paths get the standard service prefix.
    const withPrefix = normalizedPath.startsWith('/sap/')
      ? normalizedPath
      : `${this.gatewayBasePath}${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}`;

    const queryString = buildQueryString(query);
    return `${this.baseUrl}${withPrefix}${queryString ? `?${queryString}` : ''}`;
  }

  async rawRequest({ method = 'get', url, headers, body }) {
    return axios({
      method,
      url,
      data: body,
      headers,
      auth: this.auth,
      httpsAgent,
      timeout: this.timeoutMs,
    });
  }

  // Fetches (and caches) the CSRF token by issuing a GET on the service
  // document of the target service. Gateway ties the token to the session
  // cookie returned alongside it, so both travel together on writes.
  async ensureCsrfState(path, { forceRefresh = false } = {}) {
    if (this.csrfState && !forceRefresh) {
      return this.csrfState;
    }

    const serviceRootMatch = /^\/?([^/]+)/.exec(String(path || '').replace(/^\/sap\/.*$/, ''));
    const serviceRoot = serviceRootMatch ? `/${serviceRootMatch[1]}/` : '/';
    const url = this.buildUrl(serviceRoot, {});

    const response = await this.rawRequest({
      method: 'get',
      url,
      headers: { 'x-csrf-token': 'Fetch' },
    });

    const token = response?.headers?.['x-csrf-token'];
    if (!token) {
      throw new Error('Unable to obtain CSRF token from S4 Gateway');
    }

    this.csrfState = {
      token,
      cookie: readCsrfCookie(response),
    };

    return this.csrfState;
  }

  async request({ method = 'get', path, query, headers, body } = {}) {
    const normalizedMethod = String(method || 'get').toLowerCase();
    const url = this.buildUrl(path, query);

    if (!UNSAFE_METHODS.has(normalizedMethod)) {
      const response = await this.rawRequest({ method: normalizedMethod, url, headers, body });
      return normalizeODataV2Response(response.data);
    }

    const performWrite = async (csrfState) => this.rawRequest({
      method: normalizedMethod,
      url,
      body,
      headers: {
        'x-csrf-token': csrfState.token,
        ...(csrfState.cookie ? { Cookie: csrfState.cookie } : {}),
        ...(headers || {}),
      },
    });

    try {
      const csrfState = await this.ensureCsrfState(path);
      const response = await performWrite(csrfState);
      return normalizeODataV2Response(response.data);
    } catch (error) {
      if (!isCsrfRejection(error)) {
        throw error;
      }

      logger.warn('S4 Gateway rejected CSRF token, refreshing and retrying once', {
        path,
      });

      const refreshed = await this.ensureCsrfState(path, { forceRefresh: true });
      const response = await performWrite(refreshed);
      return normalizeODataV2Response(response.data);
    }
  }

  async fetchAll({ path, query, headers } = {}) {
    const items = [];
    let nextUrl = this.buildUrl(path, query);

    while (nextUrl) {
      // eslint-disable-next-line no-await-in-loop
      const response = await this.rawRequest({ method: 'get', url: nextUrl, headers });
      const raw = response?.data;
      const normalized = normalizeODataV2Response(raw);

      if (Array.isArray(normalized)) {
        items.push(...normalized);
      } else if (normalized) {
        items.push(normalized);
      }

      // __next is an absolute URL emitted by Gateway; it already carries the
      // skiptoken and $format, so it is followed verbatim.
      nextUrl = extractODataV2NextLink(raw);
    }

    return items;
  }
}

export default S4GatewayTransport;
