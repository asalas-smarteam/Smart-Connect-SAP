function getTenantDealModels(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for deal mapping operations');
  }

  const { DealPipelineMapping, DealStageMapping } = tenantModels;
  return { DealPipelineMapping, DealStageMapping };
}

const dealMappingService = {
  async getPipelineMapping(hubspotCredentialId, sapPipelineKey, tenantModels) {
    if (!hubspotCredentialId || !sapPipelineKey) {
      return null;
    }

    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    return DealPipelineMapping.findOne({ hubspotCredentialId, sapPipelineKey });
  },

  async getStageMapping(hubspotCredentialId, sapStageKey, hubspotPipelineId, tenantModels) {
    if (!hubspotCredentialId || !sapStageKey || !hubspotPipelineId) {
      return null;
    }

    const { DealStageMapping } = getTenantDealModels(tenantModels);
    return DealStageMapping.findOne({
      hubspotCredentialId,
      sapStageKey,
      hubspotPipelineId,
    });
  },

  async listPipelineMappings(hubspotCredentialId, tenantModels) {
    if (!hubspotCredentialId) {
      return [];
    }

    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    return DealPipelineMapping.find({ hubspotCredentialId }).sort({ hubspotPipelineLabel: 1, createdAt: 1 });
  },

  async listStageMappings(hubspotCredentialId, hubspotPipelineId, tenantModels) {
    if (!hubspotCredentialId) {
      return [];
    }

    const { DealStageMapping } = getTenantDealModels(tenantModels);
    const filter = { hubspotCredentialId };

    if (hubspotPipelineId) {
      filter.hubspotPipelineId = hubspotPipelineId;
    }

    return DealStageMapping.find(filter).sort({ hubspotStageLabel: 1, createdAt: 1 });
  },

  async createOrUpdatePipelineMapping({
    hubspotCredentialId,
    sapPipelineKey,
    tenantModels,
    ...data
  }) {
    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    const existing = await this.getPipelineMapping(
      hubspotCredentialId,
      sapPipelineKey,
      tenantModels
    );

    if (existing) {
      existing.set(data);
      return existing.save();
    }

    return DealPipelineMapping.create({
      ...data,
      hubspotCredentialId,
      sapPipelineKey,
    });
  },

  async createOrUpdateStageMapping({
    hubspotCredentialId,
    sapStageKey,
    hubspotPipelineId,
    tenantModels,
    ...data
  }) {
    const { DealStageMapping } = getTenantDealModels(tenantModels);
    const existing = await this.getStageMapping(
      hubspotCredentialId,
      sapStageKey,
      hubspotPipelineId,
      tenantModels
    );

    if (existing) {
      existing.set(data);
      return existing.save();
    }

    return DealStageMapping.create({
      ...data,
      hubspotCredentialId,
      sapStageKey,
      hubspotPipelineId,
    });
  },

  async getPipelineMappingById(id, tenantModels) {
    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    return DealPipelineMapping.findById(id);
  },

  async updatePipelineMappingById(id, payload, tenantModels) {
    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    return DealPipelineMapping.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
  },

  async deletePipelineMappingById(id, tenantModels) {
    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    return DealPipelineMapping.findByIdAndDelete(id);
  },

  async createPipelineMapping(payload, tenantModels) {
    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    return DealPipelineMapping.create(payload);
  },

  async getStageMappingById(id, tenantModels) {
    const { DealStageMapping } = getTenantDealModels(tenantModels);
    return DealStageMapping.findById(id);
  },

  async updateStageMappingById(id, payload, tenantModels) {
    const { DealStageMapping } = getTenantDealModels(tenantModels);
    return DealStageMapping.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
  },

  async deleteStageMappingById(id, tenantModels) {
    const { DealStageMapping } = getTenantDealModels(tenantModels);
    return DealStageMapping.findByIdAndDelete(id);
  },

  async createStageMapping(payload, tenantModels) {
    const { DealStageMapping } = getTenantDealModels(tenantModels);
    return DealStageMapping.create(payload);
  },
};

export default dealMappingService;
