function getTenantDealModels(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for deal mapping resolution');
  }

  const { DealPipelineMapping, DealStageMapping } = tenantModels;
  return { DealPipelineMapping, DealStageMapping };
}

const dealMappingResolver = {
  async resolvePipeline(hubspotCredentialId, sapPipelineKey, tenantModels) {
    const { DealPipelineMapping } = getTenantDealModels(tenantModels);
    const result = await DealPipelineMapping.findOne({ hubspotCredentialId, sapPipelineKey });

    if (!result) {
      return null;
    }

    return { hubspotPipelineId: result.hubspotPipelineId };
  },

  async resolveStage(hubspotCredentialId, sapPipelineKey, sapStageKey, tenantModels) {
    const { DealStageMapping } = getTenantDealModels(tenantModels);
    const pipeline = await this.resolvePipeline(hubspotCredentialId, sapPipelineKey, tenantModels);

    if (!pipeline) {
      return null;
    }

    const result = await DealStageMapping.findOne({
      hubspotCredentialId,
      sapStageKey,
      hubspotPipelineId: pipeline.hubspotPipelineId,
    });

    if (!result) {
      return null;
    }

    return { hubspotStageId: result.hubspotStageId };
  },
};

export default dealMappingResolver;
