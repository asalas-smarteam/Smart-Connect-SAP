import { SaaSClient } from '../../../config/database.js';
import { getTenantConnection, getTenantModels } from '../../../config/tenantDatabase.js';

export class OAuthTenantRepository {
  async getTenantModels(tenantKey) {
    return getTenantModels(tenantKey);
  }

  async getTenantConnection(tenantKey) {
    return getTenantConnection(tenantKey);
  }

  async findClientById(tenantId) {
    return SaaSClient.findById(tenantId);
  }

  async ensureHubspotCredential({ tenantModels, client, portalId }) {
    const { ClientConfig, HubspotCredentials } = tenantModels;

    let clientConfig = await ClientConfig.findOne();
    if (!clientConfig) {
      clientConfig = await ClientConfig.create({ clientName: client.companyName });
    }

    let credentials = await HubspotCredentials.findOne({ clientConfigId: clientConfig._id });
    if (!credentials) {
      credentials = await HubspotCredentials.create({
        clientConfigId: clientConfig._id,
        portalId,
      });
    } else if (credentials.portalId !== portalId) {
      credentials.portalId = portalId;
      await credentials.save();
    }

    if (
      !clientConfig.hubspotCredentialId ||
      clientConfig.hubspotCredentialId.toString() !== credentials._id.toString()
    ) {
      clientConfig.hubspotCredentialId = credentials._id;
      await clientConfig.save();
    }

    return { clientConfig, credentials };
  }

  async updateClientHubspotPortal({ client, portalId }) {
    client.hubspot = {
      ...client.hubspot,
      portalId,
    };
    await client.save();
  }
}

export default OAuthTenantRepository;
