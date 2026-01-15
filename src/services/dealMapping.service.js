import { DealPipelineMapping, DealStageMapping } from '../config/database.js';

const dealMappingService = {
  async getPipelineMapping(hubspotCredentialId, sapPipelineKey) {
    if (!hubspotCredentialId || !sapPipelineKey) {
      return null;
    }

    return DealPipelineMapping.findOne({ hubspotCredentialId, sapPipelineKey });
  },

  async getStageMapping(hubspotCredentialId, sapStageKey, hubspotPipelineId) {
    if (!hubspotCredentialId || !sapStageKey || !hubspotPipelineId) {
      return null;
    }

    return DealStageMapping.findOne({
      hubspotCredentialId,
      sapStageKey,
      hubspotPipelineId,
    });
  },

  async listPipelineMappings(hubspotCredentialId) {
    if (!hubspotCredentialId) {
      return [];
    }

    return DealPipelineMapping.find({ hubspotCredentialId }).sort({ createdAt: 1 });
  },

  async listStageMappings(hubspotCredentialId, hubspotPipelineId) {
    if (!hubspotCredentialId || !hubspotPipelineId) {
      return [];
    }

    return DealStageMapping.find({ hubspotCredentialId, hubspotPipelineId }).sort({
      createdAt: 1,
    });
  },

  async createOrUpdatePipelineMapping({ hubspotCredentialId, sapPipelineKey, ...data }) {
    const existing = await this.getPipelineMapping(hubspotCredentialId, sapPipelineKey);

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

  async createOrUpdateStageMapping({ hubspotCredentialId, sapStageKey, hubspotPipelineId, ...data }) {
    const existing = await this.getStageMapping(hubspotCredentialId, sapStageKey, hubspotPipelineId);

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
};

export default dealMappingService;
