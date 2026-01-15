import { DealPipelineMapping, DealStageMapping } from '../config/database.js';

const dealMappingResolver = {
  async resolvePipeline(hubspotCredentialId, sapPipelineKey) {
    const result = await DealPipelineMapping.findOne({ hubspotCredentialId, sapPipelineKey });

    if (!result) {
      return null;
    }

    return { hubspotPipelineId: result.hubspotPipelineId };
  },

  async resolveStage(hubspotCredentialId, sapPipelineKey, sapStageKey) {
    const pipeline = await this.resolvePipeline(hubspotCredentialId, sapPipelineKey);

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
