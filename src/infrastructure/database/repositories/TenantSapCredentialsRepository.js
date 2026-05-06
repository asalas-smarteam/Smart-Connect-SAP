export class TenantSapCredentialsRepository {
  async findClientConfigById({ tenantModels, id }) {
    return tenantModels.ClientConfig.findById(id).lean();
  }

  async create({ tenantModels, payload }) {
    return tenantModels.SapCredentials.create(payload);
  }

  async list({ tenantModels, filter }) {
    return tenantModels.SapCredentials.find(filter).sort({ createdAt: -1 });
  }

  async findById({ tenantModels, id }) {
    return tenantModels.SapCredentials.findById(id);
  }

  async updateById({ tenantModels, id, payload }) {
    return tenantModels.SapCredentials.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });
  }

  async deleteById({ tenantModels, id }) {
    return tenantModels.SapCredentials.findByIdAndDelete(id);
  }
}

export default TenantSapCredentialsRepository;
