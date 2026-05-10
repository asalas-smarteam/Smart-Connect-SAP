import axios from 'axios';
import https from 'https';
import sapSessionManager, { isSessionInvalidError } from './sapSessionManager.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function cleanBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

async function serviceLayerRequest(sapConfig, { method, path, data }) {
  const baseUrl = cleanBaseUrl(sapConfig?.serviceLayerBaseUrl);

  if (!baseUrl) {
    throw new Error('Missing serviceLayerBaseUrl for SAP BusinessPartner update');
  }

  const url = `${baseUrl}/b1s/v2${path.startsWith('/') ? path : `/${path}`}`;

  const requestWithSession = async () => {
    const { cookie } = await sapSessionManager.getSessionCookie(sapConfig);
    const response = await axios({
      method,
      url,
      data,
      headers: { Cookie: cookie },
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

export const sapBusinessPartnerAdapter = Object.freeze({
  updateBusinessPartner({ sapConfig, cardCode, payload }) {
    if (!cardCode || !payload || Object.keys(payload).length === 0) {
      return null;
    }

    return serviceLayerRequest(sapConfig, {
      method: 'patch',
      path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
      data: payload,
    });
  },
});

export default sapBusinessPartnerAdapter;
