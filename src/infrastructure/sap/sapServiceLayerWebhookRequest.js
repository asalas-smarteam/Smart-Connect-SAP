import axios from 'axios';
import https from 'https';
import sapSessionManager, { isSessionInvalidError } from './sapSessionManager.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function cleanBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// Shared SAP Service Layer request used by webhook adapters (Orders, Quotations).
// Handles session cookie resolution and a single retry on invalid-session errors.
export async function sapServiceLayerWebhookRequest(sapConfig, { method, path, data, params, headers }) {
  const baseUrl = cleanBaseUrl(sapConfig?.serviceLayerBaseUrl);

  if (!baseUrl) {
    throw new Error('Missing serviceLayerBaseUrl for webhook processing');
  }

  const url = `${baseUrl}/b1s/v2${path.startsWith('/') ? path : `/${path}`}`;

  const requestWithSession = async () => {
    const { cookie } = await sapSessionManager.getSessionCookie(sapConfig);
    const response = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Cookie: cookie,
        ...(headers || {}),
      },
      httpsAgent,
    });
    return response.data;
  };

  try {
    return await requestWithSession();
  } catch (error) {
    if (!isSessionInvalidError(error)) {
      throw error;
    }

    const tenantKey = sapSessionManager.resolveTenantKey(sapConfig);
    await sapSessionManager.invalidateSession(tenantKey);
    return requestWithSession();
  }
}

export default sapServiceLayerWebhookRequest;
