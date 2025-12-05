import { DealPipelineMapping, DealStageMapping } from '../config/database.js';

const dealMappingService = {
  async getPipelineMapping(hubspotCredentialId, sapPipelineKey) {
    if (!hubspotCredentialId || !sapPipelineKey) {
      return null;
    }

    return DealPipelineMapping.findOne({
      where: { hubspotCredentialId, sapPipelineKey },
    });
  },

  async getStageMapping(hubspotCredentialId, sapStageKey, hubspotPipelineId) {
    if (!hubspotCredentialId || !sapStageKey || !hubspotPipelineId) {
      return null;
    }

    return DealStageMapping.findOne({
      where: { hubspotCredentialId, sapStageKey, hubspotPipelineId },
    });
  },

  async listPipelineMappings(hubspotCredentialId) {
    if (!hubspotCredentialId) {
      return [];
    }

    return DealPipelineMapping.findAll({
      where: { hubspotCredentialId },
      order: [['createdAt', 'ASC']],
    });
  },

  async listStageMappings(hubspotCredentialId, hubspotPipelineId) {
    if (!hubspotCredentialId || !hubspotPipelineId) {
      return [];
    }

    return DealStageMapping.findAll({
      where: { hubspotCredentialId, hubspotPipelineId },
      order: [['createdAt', 'ASC']],
    });
  },

  async createOrUpdatePipelineMapping(hubspotCredentialId, sapPipelineKey, data) {
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

  async createOrUpdateStageMapping(hubspotCredentialId, sapStageKey, hubspotPipelineId, data) {
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
