import service from '../services/dealMapping.service.js';
import { requireTenantModels } from '../utils/tenantModels.js';

const dealMappingController = {
  async listPipelines(req, reply) {
    try {
      const { hubspotCredentialId } = req.params;
      const tenantModels = requireTenantModels(req);
      const pipelines = await service.listPipelineMappings(hubspotCredentialId, tenantModels);

      return reply.send({ ok: true, pipelines });
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  },

  async listStages(req, reply) {
    try {
      const { hubspotCredentialId, pipelineId } = req.params;
      const tenantModels = requireTenantModels(req);
      const stages = await service.listStageMappings(hubspotCredentialId, pipelineId, tenantModels);

      return reply.send({ ok: true, stages });
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  },

  async upsertPipeline(req, reply) {
    try {
      const tenantModels = requireTenantModels(req);
      const { sapPipelineKey, hubspotPipelineId, hubspotPipelineLabel, description } =
        req.body;
      const { hubspotCredentialId } = req.params;

      await service.createOrUpdatePipelineMapping({
        sapPipelineKey,
        hubspotPipelineId,
        hubspotPipelineLabel,
        description,
        hubspotCredentialId,
        tenantModels,
      });

      return reply.send({ ok: true });
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  },

  async upsertStage(req, reply) {
    try {
      const tenantModels = requireTenantModels(req);
      const { sapStageKey, hubspotStageId, hubspotStageLabel, hubspotPipelineId, description } =
        req.body;
      const { hubspotCredentialId } = req.params;

      await service.createOrUpdateStageMapping({
        sapStageKey,
        hubspotStageId,
        hubspotStageLabel,
        hubspotPipelineId,
        description,
        hubspotCredentialId,
        tenantModels,
      });

      return reply.send({ ok: true });
    } catch (error) {
      return reply.send({ ok: false, message: error.message });
    }
  },
};

export default dealMappingController;
