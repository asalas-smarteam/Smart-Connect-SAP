import axios from 'axios';
import { buildServiceLayerUrl } from './serviceLayerUrlBuilder.js';
import logger from '../core/logger.js';
import https from "https";

const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // 👈 permite cert aunque no matchee el hostname
});

function buildAuthPayload(config) {
  const payload = {
    UserName: config?.serviceLayerUsername,
    Password: config?.serviceLayerPassword
  };

  if (config?.serviceLayerCompanyDB) {
    payload.CompanyDB = config.serviceLayerCompanyDB;
  }

  return payload;
}

function readSessionCookie(response) {
  const setCookie = response?.headers?.['set-cookie'] || [];
  const sessionCookie = setCookie.find((cookie) => cookie.startsWith('B1SESSION='));

  if (!sessionCookie) {
    return null;
  }

  return sessionCookie.split(';')[0];
}

const serviceLayerService = {
  async execute(config, mappings, options = {}) {
    const baseUrl = String(config?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');

    if (!baseUrl) {
      throw new Error('serviceLayerBaseUrl is required for SERVICE_LAYER mode');
    }



    const loginUrl = `${baseUrl}/b1s/v2/Login`;
    const logoutUrl = `${baseUrl}/b1s/v2/Logout`;
    const dataUrl = buildServiceLayerUrl(config, mappings, options);

    const loginResponse = await axios.post(
    loginUrl,
    buildAuthPayload(config),
    { httpsAgent } 
    );
    const sessionCookie = readSessionCookie(loginResponse);

    if (!sessionCookie) {
      throw new Error('Unable to establish SAP Service Layer session');
    }

    const headers = {
      Cookie: sessionCookie,
    };

    try {
      const response = await axios.get(dataUrl, {
        headers,
        httpsAgent, 
      });
      return response?.data?.value || response?.data || [];
    } finally {
      try {
        await axios.post(logoutUrl, {}, { headers, httpsAgent });;
      } catch (logoutError) {
        logger.warn('SAP Service Layer logout failed', { error: logoutError.message });
      }
    }
  },
};

export default serviceLayerService;
