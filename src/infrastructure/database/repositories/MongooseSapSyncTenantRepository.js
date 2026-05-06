import { getTenantModels } from '../tenant/tenantDatabase.js';

export class MongooseSapSyncTenantRepository {
  async getTenantModels(tenantKey) {
    return getTenantModels(tenantKey);
  }

  async loadConfig({ tenantKey, configId }) {
    const tenantModels = await this.getTenantModels(tenantKey);
    const { ClientConfig } = tenantModels;
    const config = await ClientConfig.findById(configId);

    return {
      tenantModels,
      config,
    };
  }

  async findActiveConfigs(tenantKey) {
    const tenantModels = await this.getTenantModels(tenantKey);
    const { ClientConfig } = tenantModels;
    const configs = await ClientConfig.find({ active: true });

    return {
      tenantModels,
      configs,
    };
  }
}

export default MongooseSapSyncTenantRepository;

