import axios from 'axios';
import { getConnection } from '../utils/externalDb.js';

async function resolveClientConfig({ hubspotCredentialId, objectType, tenantModels }) {
  if (!tenantModels) {
    throw new Error('Tenant models are required to resolve SAP config');
  }

  const { ClientConfig } = tenantModels;

  const config = await ClientConfig.findOne({
    hubspotCredentialId,
    objectType,
    active: true,
  }).populate({
    path: 'integrationModeId',
    select: 'name',
  });

  if (!config) {
    throw new Error('Active client configuration not found for webhook processing');
  }

  return config;
}

const sapWebhookService = {
  async sendToSap({ payload, objectType, hubspotCredentialId, tenantModels }) {
    const config = await resolveClientConfig({ hubspotCredentialId, objectType, tenantModels });

    switch (config?.integrationModeId?.name) {
      case 'STORE_PROCEDURE': {
        const { storeProcedureName } = config || {};

        if (!storeProcedureName) {
          throw new Error('Stored procedure name is required for SAP webhook processing');
        }

        const externalSequelize = getConnection(config);
        await externalSequelize.query(`EXEC ${storeProcedureName} @payload=:payload`, {
          replacements: { payload: JSON.stringify(payload) },
        });
        return { ok: true };
      }
      case 'SQL_SCRIPT': {
        const { sqlQuery } = config || {};

        if (!sqlQuery) {
          throw new Error('SQL query is required for SAP webhook processing');
        }

        const externalSequelize = getConnection(config);
        await externalSequelize.query(sqlQuery, {
          replacements: { payload: JSON.stringify(payload) },
        });
        return { ok: true };
      }
      case 'API': {
        const { apiUrl, apiToken } = config || {};

        if (!apiUrl) {
          throw new Error('API URL is required for SAP webhook processing');
        }

        const headers = {};
        if (apiToken) {
          headers.Authorization = `Bearer ${apiToken}`;
        }

        await axios.post(apiUrl, payload, { headers });
        return { ok: true };
      }
      default:
        throw new Error('Unsupported SAP integration mode for webhook processing');
    }
  },
};

export default sapWebhookService;
