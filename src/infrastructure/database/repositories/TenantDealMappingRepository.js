export class TenantDealMappingRepository {
  getModels(tenantModels) {
    if (!tenantModels?.DealPipelineMapping || !tenantModels?.DealStageMapping) {
      throw new Error('Tenant models are required for deal mapping operations');
    }

    const { DealPipelineMapping, DealStageMapping } = tenantModels;
    return { DealPipelineMapping, DealStageMapping };
  }

  async listPipelines({ tenantModels, hubspotCredentialId }) {
    return this.getModels(tenantModels)
      .DealPipelineMapping
      .find({ hubspotCredentialId })
      .sort({ hubspotPipelineLabel: 1, createdAt: 1 });
  }

  async listStages({ tenantModels, hubspotCredentialId, hubspotPipelineId }) {
    const filter = { hubspotCredentialId };

    if (hubspotPipelineId) {
      filter.hubspotPipelineId = hubspotPipelineId;
    }

    return this.getModels(tenantModels)
      .DealStageMapping
      .find(filter)
      .sort({ hubspotStageLabel: 1, createdAt: 1 });
  }

  async createPipeline({ tenantModels, payload }) {
    return this.getModels(tenantModels).DealPipelineMapping.create(payload);
  }

  async updatePipelineById({ tenantModels, id, payload }) {
    return this.getModels(tenantModels).DealPipelineMapping.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });
  }

  async deletePipelineById({ tenantModels, id }) {
    return this.getModels(tenantModels).DealPipelineMapping.findByIdAndDelete(id);
  }

  async createStage({ tenantModels, payload }) {
    return this.getModels(tenantModels).DealStageMapping.create(payload);
  }

  async updateStageById({ tenantModels, id, payload }) {
    return this.getModels(tenantModels).DealStageMapping.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });
  }

  async deleteStageById({ tenantModels, id }) {
    return this.getModels(tenantModels).DealStageMapping.findByIdAndDelete(id);
  }

  async findPipeline({ tenantModels, hubspotCredentialId, sapPipelineKey }) {
    return this.getModels(tenantModels).DealPipelineMapping.findOne({
      hubspotCredentialId,
      sapPipelineKey,
    });
  }

  async findStage({ tenantModels, hubspotCredentialId, sapStageKey, hubspotPipelineId }) {
    return this.getModels(tenantModels).DealStageMapping.findOne({
      hubspotCredentialId,
      sapStageKey,
      hubspotPipelineId,
    });
  }
}

export default TenantDealMappingRepository;
