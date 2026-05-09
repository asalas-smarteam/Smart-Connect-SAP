function getFieldMappingModel(tenantModels) {
  if (!tenantModels?.FieldMapping) {
    throw new Error('Tenant models are required for mapping operations');
  }

  return tenantModels.FieldMapping;
}

function buildContextFilter(sourceContext, { includeMissingBusinessPartner = false } = {}) {
  if (sourceContext === 'businessPartner' && includeMissingBusinessPartner) {
    return {
      $or: [{ sourceContext: 'businessPartner' }, { sourceContext: { $exists: false } }],
    };
  }

  return { sourceContext };
}

export class TenantFieldMappingRepository {
  async findByCredentialObjectAndContext({
    tenantModels,
    hubspotCredentialId,
    objectType,
    sourceContext,
    activeOnly = false,
    includeMissingBusinessPartner = false,
  }) {
    const FieldMapping = getFieldMappingModel(tenantModels);
    const filter = {
      hubspotCredentialId,
      objectType,
      ...buildContextFilter(sourceContext, { includeMissingBusinessPartner }),
    };

    if (activeOnly) {
      filter.isActive = true;
    }

    return FieldMapping.find(filter).sort({ _id: 1 });
  }

  async findActiveByClientConfig({ tenantModels, clientConfigId }) {
    const FieldMapping = getFieldMappingModel(tenantModels);
    return FieldMapping.find({ clientConfigId, isActive: true }).sort({ _id: 1 });
  }
}

export default TenantFieldMappingRepository;
