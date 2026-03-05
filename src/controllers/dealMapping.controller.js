import mongoose from 'mongoose';
import service from '../services/dealMapping.service.js';
import { requireTenantModels } from '../utils/tenantModels.js';

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function duplicateKey(error) {
  return error?.code === 11000;
}

const dealMappingController = {
  async listPipelines(req, reply) {
    try {
      const { hubspotCredentialId } = req.query || {};
      if (!hubspotCredentialId) {
        return reply.code(400).send({ success: false, message: 'hubspotCredentialId is required' });
      }

      if (!isValidObjectId(hubspotCredentialId)) {
        return reply.code(400).send({ success: false, message: 'Invalid hubspotCredentialId' });
      }

      const tenantModels = requireTenantModels(req);
      const pipelines = await service.listPipelineMappings(hubspotCredentialId, tenantModels);

      return reply.send({ success: true, data: pipelines });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async listStages(req, reply) {
    try {
      const { hubspotCredentialId, hubspotPipelineId } = req.query || {};
      if (!hubspotCredentialId) {
        return reply.code(400).send({ success: false, message: 'hubspotCredentialId is required' });
      }

      if (!isValidObjectId(hubspotCredentialId)) {
        return reply.code(400).send({ success: false, message: 'Invalid hubspotCredentialId' });
      }

      const tenantModels = requireTenantModels(req);
      const stages = await service.listStageMappings(
        hubspotCredentialId,
        hubspotPipelineId,
        tenantModels
      );

      return reply.send({ success: true, data: stages });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async upsertPipeline(req, reply) {
    try {
      const tenantModels = requireTenantModels(req);
      const { sapPipelineKey, hubspotPipelineId, hubspotPipelineLabel, description } = req.body;
      const { hubspotCredentialId } = req.params;

      await service.createOrUpdatePipelineMapping({
        sapPipelineKey,
        hubspotPipelineId,
        hubspotPipelineLabel,
        description,
        hubspotCredentialId,
        tenantModels,
      });

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
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

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async patchPipeline(req, reply) {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return reply.code(400).send({ success: false, message: 'Invalid mapping id' });
      }

      const updatePayload = {};
      const { sapPipelineKey, description } = req.body || {};
      if (Object.hasOwn(req.body || {}, 'sapPipelineKey')) {
        updatePayload.sapPipelineKey = sapPipelineKey;
      }
      if (Object.hasOwn(req.body || {}, 'description')) {
        updatePayload.description = description;
      }

      const tenantModels = requireTenantModels(req);
      const updated = await service.updatePipelineMappingById(id, updatePayload, tenantModels);

      if (!updated) {
        return reply.code(404).send({ success: false, message: 'Pipeline mapping not found' });
      }

      req.log?.info({ msg: 'Deal pipeline mapping updated', id, updatePayload });
      return reply.send({ success: true, data: updated });
    } catch (error) {
      if (duplicateKey(error)) {
        return reply.code(409).send({ success: false, message: 'Pipeline mapping conflict' });
      }
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async deletePipeline(req, reply) {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return reply.code(400).send({ success: false, message: 'Invalid mapping id' });
      }

      const tenantModels = requireTenantModels(req);
      const deleted = await service.deletePipelineMappingById(id, tenantModels);
      if (!deleted) {
        return reply.code(404).send({ success: false, message: 'Pipeline mapping not found' });
      }

      req.log?.info({ msg: 'Deal pipeline mapping deleted', id });
      return reply.send({ success: true, data: deleted });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async createPipeline(req, reply) {
    try {
      const payload = req.body || {};
      if (!payload.hubspotCredentialId || !payload.hubspotPipelineId) {
        return reply
          .code(400)
          .send({ success: false, message: 'hubspotCredentialId and hubspotPipelineId are required' });
      }

      if (!isValidObjectId(payload.hubspotCredentialId)) {
        return reply.code(400).send({ success: false, message: 'Invalid hubspotCredentialId' });
      }

      const tenantModels = requireTenantModels(req);
      const created = await service.createPipelineMapping(payload, tenantModels);

      req.log?.info({ msg: 'Deal pipeline mapping created', id: created._id });
      return reply.code(201).send({ success: true, data: created });
    } catch (error) {
      if (duplicateKey(error)) {
        return reply.code(409).send({ success: false, message: 'Pipeline mapping conflict' });
      }
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async patchStage(req, reply) {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return reply.code(400).send({ success: false, message: 'Invalid mapping id' });
      }

      const updatePayload = {};
      const { sapStageKey, description } = req.body || {};
      if (Object.hasOwn(req.body || {}, 'sapStageKey')) {
        updatePayload.sapStageKey = sapStageKey;
      }
      if (Object.hasOwn(req.body || {}, 'description')) {
        updatePayload.description = description;
      }

      const tenantModels = requireTenantModels(req);
      const updated = await service.updateStageMappingById(id, updatePayload, tenantModels);

      if (!updated) {
        return reply.code(404).send({ success: false, message: 'Stage mapping not found' });
      }

      req.log?.info({ msg: 'Deal stage mapping updated', id, updatePayload });
      return reply.send({ success: true, data: updated });
    } catch (error) {
      if (duplicateKey(error)) {
        return reply.code(409).send({ success: false, message: 'Stage mapping conflict' });
      }
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async deleteStage(req, reply) {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return reply.code(400).send({ success: false, message: 'Invalid mapping id' });
      }

      const tenantModels = requireTenantModels(req);
      const deleted = await service.deleteStageMappingById(id, tenantModels);
      if (!deleted) {
        return reply.code(404).send({ success: false, message: 'Stage mapping not found' });
      }

      req.log?.info({ msg: 'Deal stage mapping deleted', id });
      return reply.send({ success: true, data: deleted });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  },

  async createStage(req, reply) {
    try {
      const payload = req.body || {};
      if (!payload.hubspotCredentialId || !payload.hubspotPipelineId || !payload.hubspotStageId) {
        return reply.code(400).send({
          success: false,
          message: 'hubspotCredentialId, hubspotPipelineId and hubspotStageId are required',
        });
      }

      if (!isValidObjectId(payload.hubspotCredentialId)) {
        return reply.code(400).send({ success: false, message: 'Invalid hubspotCredentialId' });
      }

      const tenantModels = requireTenantModels(req);
      const created = await service.createStageMapping(payload, tenantModels);

      req.log?.info({ msg: 'Deal stage mapping created', id: created._id });
      return reply.code(201).send({ success: true, data: created });
    } catch (error) {
      if (duplicateKey(error)) {
        return reply.code(409).send({ success: false, message: 'Stage mapping conflict' });
      }
      return reply.code(500).send({ success: false, message: error.message });
    }
  },
};

export default dealMappingController;
