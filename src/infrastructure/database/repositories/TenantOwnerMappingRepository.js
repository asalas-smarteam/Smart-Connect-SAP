export class TenantOwnerMappingRepository {
  getModel(tenantModels) {
    if (!tenantModels?.OwnerMapping) {
      throw new Error('Tenant models are required for owner mappings');
    }

    return tenantModels.OwnerMapping;
  }

  async list({ tenantModels, hubspotCredentialId }) {
    return this.getModel(tenantModels)
      .find({ hubspotCredentialId })
      .sort({ hubspotOwnerName: 1 });
  }

  async getById({ tenantModels, id }) {
    return this.getModel(tenantModels).findById(id);
  }

  async updateById({ tenantModels, id, payload }) {
    return this.getModel(tenantModels).findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });
  }

  async deleteById({ tenantModels, id }) {
    return this.getModel(tenantModels).findByIdAndDelete(id);
  }

  async create({ tenantModels, payload }) {
    return this.getModel(tenantModels).create({
      ...payload,
      source: payload.source || 'manual',
    });
  }

  async findByHubspotCredentialAndSapOwner({ tenantModels, hubspotCredentialId, sapOwnerId }) {
    return this.getModel(tenantModels).findOne({ hubspotCredentialId, sapOwnerId });
  }
}

export default TenantOwnerMappingRepository;
