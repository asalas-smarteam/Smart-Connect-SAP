function getTenantModels(tenantModels) {
  if (!tenantModels?.FieldMapping) {
    throw new Error('Tenant models are required for mapping operations');
  }

  return tenantModels;
}

export class TenantMappingManagementRepository {
  async findActiveClientConfig({ tenantModels, objectType }) {
    const { ClientConfig } = getTenantModels(tenantModels);
    return ClientConfig.findOne({ objectType, active: true }).lean();
  }

  async findDuplicate({ tenantModels, hubspotCredentialId, objectType, sourceContext, sourceField }) {
    const { FieldMapping } = getTenantModels(tenantModels);
    return FieldMapping.findOne({
      hubspotCredentialId,
      objectType,
      sourceContext,
      sourceField,
    }).lean();
  }

  async create({ tenantModels, data }) {
    const { FieldMapping } = getTenantModels(tenantModels);
    return FieldMapping.create(data);
  }

  async list({ tenantModels, filter }) {
    const { FieldMapping } = getTenantModels(tenantModels);
    return FieldMapping.find(filter).sort({ _id: 1 });
  }
}

export default TenantMappingManagementRepository;
