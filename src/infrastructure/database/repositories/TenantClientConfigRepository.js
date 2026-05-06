export class TenantClientConfigRepository {
  async integrationModeExists({ tenantModels, id }) {
    return tenantModels.IntegrationMode.exists({ _id: id });
  }

  async findDefaultSapFilters({ tenantModels, objectType }) {
    return tenantModels.SapFilter.find({ objectType, active: true }).lean();
  }

  async createClientConfig({ tenantModels, payload }) {
    return tenantModels.ClientConfig.create(payload);
  }

  async listClientConfigs({ tenantModels }) {
    return tenantModels.ClientConfig.find().populate('integrationModeId');
  }

  async createIntegrationMode({ tenantModels, payload }) {
    return tenantModels.IntegrationMode.create(payload);
  }

  async listIntegrationModes({ tenantModels }) {
    return tenantModels.IntegrationMode.find().lean();
  }

  async findClientConfigById({ tenantModels, id }) {
    return tenantModels.ClientConfig.findById(id);
  }
}

export default TenantClientConfigRepository;
