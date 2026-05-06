import ManageDealMappings, {
  dealMappingReasons,
} from '../../../application/use-cases/ManageDealMappings.js';
import MongooseObjectIdValidator from '../../../infrastructure/database/MongooseObjectIdValidator.js';
import TenantDealMappingRepository from '../../../infrastructure/database/repositories/TenantDealMappingRepository.js';
import { requireTenantModels } from '../../../utils/tenantModels.js';

function buildManageDealMappings() {
  return new ManageDealMappings({
    dealMappingRepository: new TenantDealMappingRepository(),
    objectIdValidator: new MongooseObjectIdValidator(),
  });
}

function statusFor(result) {
  if (
    result.reason === dealMappingReasons.BAD_REQUEST ||
    result.reason === dealMappingReasons.INVALID_HUBSPOT_CREDENTIAL_ID ||
    result.reason === dealMappingReasons.INVALID_MAPPING_ID
  ) {
    return 400;
  }

  if (result.reason === dealMappingReasons.NOT_FOUND) {
    return 404;
  }

  if (result.reason === dealMappingReasons.CONFLICT) {
    return 409;
  }

  return 500;
}

function sendResult(reply, result) {
  if (result.ok) {
    const response = result.statusCode ? reply.code(result.statusCode) : reply;
    return response.send({ success: true, data: result.data });
  }

  return reply.code(statusFor(result)).send({
    success: false,
    message: result.message,
  });
}

function createDealMappingController({
  manageDealMappings = buildManageDealMappings(),
} = {}) {
  return {
    async listPipelines(req, reply) {
      try {
        const result = await manageDealMappings.listPipelines({
          tenantModels: requireTenantModels(req),
          hubspotCredentialId: req.query?.hubspotCredentialId,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async listStages(req, reply) {
      try {
        const result = await manageDealMappings.listStages({
          tenantModels: requireTenantModels(req),
          hubspotCredentialId: req.query?.hubspotCredentialId,
          hubspotPipelineId: req.query?.hubspotPipelineId,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async upsertPipeline(req, reply) {
      try {
        const result = await manageDealMappings.upsertPipeline({
          tenantModels: requireTenantModels(req),
          hubspotCredentialId: req.params.hubspotCredentialId,
          payload: req.body,
        });
        return result.ok ? reply.send({ success: true }) : sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async upsertStage(req, reply) {
      try {
        const result = await manageDealMappings.upsertStage({
          tenantModels: requireTenantModels(req),
          hubspotCredentialId: req.params.hubspotCredentialId,
          payload: req.body,
        });
        return result.ok ? reply.send({ success: true }) : sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async patchPipeline(req, reply) {
      try {
        const result = await manageDealMappings.patchPipeline({
          tenantModels: requireTenantModels(req),
          id: req.params.id,
          payload: req.body,
        });

        if (result.ok) {
          req.log?.info({
            msg: 'Deal pipeline mapping updated',
            id: req.params.id,
            updatePayload: result.meta?.updatePayload,
          });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async deletePipeline(req, reply) {
      try {
        const result = await manageDealMappings.deletePipeline({
          tenantModels: requireTenantModels(req),
          id: req.params.id,
        });

        if (result.ok) {
          req.log?.info({ msg: 'Deal pipeline mapping deleted', id: req.params.id });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async createPipeline(req, reply) {
      try {
        const result = await manageDealMappings.createPipeline({
          tenantModels: requireTenantModels(req),
          payload: req.body,
        });

        if (result.ok) {
          req.log?.info({ msg: 'Deal pipeline mapping created', id: result.data?._id });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async patchStage(req, reply) {
      try {
        const result = await manageDealMappings.patchStage({
          tenantModels: requireTenantModels(req),
          id: req.params.id,
          payload: req.body,
        });

        if (result.ok) {
          req.log?.info({
            msg: 'Deal stage mapping updated',
            id: req.params.id,
            updatePayload: result.meta?.updatePayload,
          });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async deleteStage(req, reply) {
      try {
        const result = await manageDealMappings.deleteStage({
          tenantModels: requireTenantModels(req),
          id: req.params.id,
        });

        if (result.ok) {
          req.log?.info({ msg: 'Deal stage mapping deleted', id: req.params.id });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async createStage(req, reply) {
      try {
        const result = await manageDealMappings.createStage({
          tenantModels: requireTenantModels(req),
          payload: req.body,
        });

        if (result.ok) {
          req.log?.info({ msg: 'Deal stage mapping created', id: result.data?._id });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },
  };
}

const dealMappingController = createDealMappingController();

export { createDealMappingController };

export default dealMappingController;
