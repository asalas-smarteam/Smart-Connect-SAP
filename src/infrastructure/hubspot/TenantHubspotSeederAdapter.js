import { FeatureFlags } from '../../config/database.js';
import { replicateMasterClientConfigs } from '../../services/tenant/replicateMasterClientConfigs.js';
import {
  seedCreateFieldsHubspot,
  seedHubspotMappings,
} from '../../services/tenant/tenantHubspotSeed.service.js';

export class MasterConfigReplicatorAdapter {
  async replicate({ tenantModels, hubspotCredentialId }) {
    return replicateMasterClientConfigs({
      masterConnection: FeatureFlags.db,
      tenantModels,
      hubspotCredentialId,
    });
  }
}

export class TenantHubspotSeederAdapter {
  async seed({ tenantConnection, credentials }) {
    await seedHubspotMappings({
      tenantConnection,
      hubspotCredential: credentials,
    });
    await seedCreateFieldsHubspot({
      hubspotCredential: credentials,
    });
  }
}
