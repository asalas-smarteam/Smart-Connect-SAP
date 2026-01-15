import axios from 'axios';
import { HubspotCredentials } from '../config/database.js';

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

function buildFormData(params) {
  const formData = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      formData.append(key, value);
    }
  });
  return formData;
}

const hubspotAuthService = {
  generateAuthUrl(clientConfigId) {
    const { HUBSPOT_CLIENT_ID, HUBSPOT_REDIRECT_URI, HUBSPOT_SCOPES } = process.env;

    const queryParams = new URLSearchParams({
      client_id: HUBSPOT_CLIENT_ID,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      state: clientConfigId,
    });

    if (HUBSPOT_SCOPES) {
      queryParams.append('scope', HUBSPOT_SCOPES);
    }

    return `https://app.hubspot.com/oauth/authorize?${queryParams.toString()}`;
  },

  async exchangeCodeForTokens(code, clientConfigId) {
    const { HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_REDIRECT_URI } = process.env;

    const payload = buildFormData({
      grant_type: 'authorization_code',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      code,
    });

    const response = await axios.post(HUBSPOT_TOKEN_URL, payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in, hub_id } = response.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    const existingCredentials = await HubspotCredentials.findOne({ where: { clientConfigId } });

    if (existingCredentials) {
      await existingCredentials.update({
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt,
        portalId: hub_id,
      });
      return existingCredentials;
    }

    return HubspotCredentials.create({
      clientConfigId,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
      portalId: hub_id,
    });
  },

  async refreshAccessToken(clientConfigId) {
    const { HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_REDIRECT_URI } = process.env;

    const credentials = await HubspotCredentials.findOne({ where: { clientConfigId } });
    if (!credentials || !credentials.refreshToken) {
      throw new Error('Refresh token not found for client configuration');
    }

    const payload = buildFormData({
      grant_type: 'refresh_token',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      refresh_token: credentials.refreshToken,
    });

    const response = await axios.post(HUBSPOT_TOKEN_URL, payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, expires_in, refresh_token } = response.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await credentials.update({
      accessToken: access_token,
      expiresAt,
      ...(refresh_token ? { refreshToken: refresh_token } : {}),
    });

    return access_token;
  },

  async getAccessToken(clientConfigId) {
    const credentials = await HubspotCredentials.findOne({ where: { clientConfigId } });

    if (!credentials) {
      throw new Error('Credentials not found for client configuration');
    }

    if (credentials.expiresAt && credentials.expiresAt > new Date()) {
      return credentials.accessToken;
    }

    return this.refreshAccessToken(clientConfigId);
  },
};

export default hubspotAuthService;
