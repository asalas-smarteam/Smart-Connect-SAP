import axios from 'axios';
function getTenantHubspotCredentials(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for HubSpot credentials');
  }
  return tenantModels.HubspotCredentials;
}

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
  generateAuthUrl(clientConfigId, stateOverride = null) {
    const { HUBSPOT_CLIENT_ID, HUBSPOT_REDIRECT_URI, HUBSPOT_SCOPES } = process.env;

    const queryParams = new URLSearchParams({
      client_id: HUBSPOT_CLIENT_ID,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      state: stateOverride || clientConfigId,
    });

    if (HUBSPOT_SCOPES) {
      queryParams.append('scope', HUBSPOT_SCOPES);
    }

    return `https://app.hubspot.com/oauth/authorize?${queryParams.toString()}`;
  },

  async exchangeCodeForTokens(code, clientConfigId, tenantModels) {
    const HubspotCredentials = getTenantHubspotCredentials(tenantModels);
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

    const existingCredentials = await HubspotCredentials.findOne({ clientConfigId });

    if (existingCredentials) {
      existingCredentials.accessToken = access_token;
      existingCredentials.refreshToken = refresh_token;
      existingCredentials.expiresAt = expiresAt;
      existingCredentials.portalId = hub_id;
      await existingCredentials.save();
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

  async refreshAccessToken(clientConfigId, tenantModels) {
    const HubspotCredentials = getTenantHubspotCredentials(tenantModels);
    const { HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_REDIRECT_URI } = process.env;

    const credentials = await HubspotCredentials.findOne({ clientConfigId });
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

    credentials.accessToken = access_token;
    credentials.expiresAt = expiresAt;
    if (refresh_token) {
      credentials.refreshToken = refresh_token;
    }

    await credentials.save();

    return access_token;
  },

  async getAccessToken(clientConfigId, tenantModels) {
    const HubspotCredentials = getTenantHubspotCredentials(tenantModels);
    const credentials = await HubspotCredentials.findOne({ clientConfigId });

    if (!credentials) {
      throw new Error('Credentials not found for client configuration');
    }

    if (credentials.expiresAt && credentials.expiresAt > new Date()) {
      return credentials.accessToken;
    }

    return this.refreshAccessToken(clientConfigId, tenantModels);
  },
};

export default hubspotAuthService;
