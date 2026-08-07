import { buildServiceLayerUrl } from './serviceLayerUrlBuilder.js';
import { B1ServiceLayerTransport } from './transport/B1ServiceLayerTransport.js';

function withTopParam(url, top) {
  if (!top || /[?&]\$top=/.test(url)) {
    return url;
  }

  return `${url}${url.includes('?') ? '&' : '?'}$top=${encodeURIComponent(String(top))}`;
}

const serviceLayerService = {
  async execute(config, mappings, options = {}) {
    const baseUrl = String(config?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

    if (!baseUrl) {
      throw new Error('serviceLayerBaseUrl is required for SERVICE_LAYER mode');
    }

    const requestOptions = {
      ...options,
      //top: options?.top || config?.serviceLayerTopFilter || 20,
    };

    const dataUrl = withTopParam(buildServiceLayerUrl(config, mappings, requestOptions)); // , requestOptions.top

    // The URL is built here (buildServiceLayerUrl knows about mappings and
    // filters), but the session cookie, the retry-once-on-invalid-session and
    // the @odata.nextLink walk are the transport's job.
    const transport = new B1ServiceLayerTransport({ config });
    return transport.fetchAll({ url: dataUrl, path: config?.serviceLayerPath ?? null });
  },
};

export default serviceLayerService;
