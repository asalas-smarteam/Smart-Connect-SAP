import ManageOwnerMappings, {
  ownerMappingReasons,
} from '../../../application/use-cases/ManageOwnerMappings.js';
import MongooseObjectIdValidator from '../../../infrastructure/database/MongooseObjectIdValidator.js';
import TenantOwnerMappingRepository from '../../../infrastructure/database/repositories/TenantOwnerMappingRepository.js';
import { requireTenantModels } from '../../../utils/tenantModels.js';

function buildManageOwnerMappings() {
  return new ManageOwnerMappings({
    ownerMappingRepository: new TenantOwnerMappingRepository(),
    objectIdValidator: new MongooseObjectIdValidator(),
  });
}

function statusFor(result) {
  if (
    result.reason === ownerMappingReasons.BAD_REQUEST ||
    result.reason === ownerMappingReasons.INVALID_HUBSPOT_CREDENTIAL_ID ||
    result.reason === ownerMappingReasons.INVALID_MAPPING_ID
  ) {
    return 400;
  }

  if (result.reason === ownerMappingReasons.NOT_FOUND) {
    return 404;
  }

  if (result.reason === ownerMappingReasons.CONFLICT) {
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

function createOwnerMappingController({
  manageOwnerMappings = buildManageOwnerMappings(),
} = {}) {
  return {
    async listOwners(req, reply) {
      try {
        const result = await manageOwnerMappings.list({
          tenantModels: requireTenantModels(req),
          hubspotCredentialId: req.query?.hubspotCredentialId,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async upsertOwner(req, reply) {
      try {
        const result = await manageOwnerMappings.upsert({
          tenantModels: requireTenantModels(req),
          hubspotCredentialId: req.params.hubspotCredentialId,
          payload: req.body,
        });
        return result.ok
          ? reply.send({ success: true })
          : sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async patchOwner(req, reply) {
      try {
        const result = await manageOwnerMappings.patch({
          tenantModels: requireTenantModels(req),
          id: req.params.id,
          payload: req.body,
        });

        if (result.ok) {
          req.log?.info({ msg: 'Owner mapping updated', id: req.params.id, updatePayload: result.meta?.updatePayload });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async deleteOwner(req, reply) {
      try {
        const result = await manageOwnerMappings.delete({
          tenantModels: requireTenantModels(req),
          id: req.params.id,
        });

        if (result.ok) {
          req.log?.info({ msg: 'Owner mapping deleted', id: req.params.id });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async createOwner(req, reply) {
      try {
        const result = await manageOwnerMappings.create({
          tenantModels: requireTenantModels(req),
          payload: req.body,
        });

        if (result.ok) {
          req.log?.info({ msg: 'Owner mapping created', id: result.data?._id });
        }

        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },

    async getOwner(req, reply) {
      try {
        const result = await manageOwnerMappings.get({
          tenantModels: requireTenantModels(req),
          id: req.params.id,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ success: false, message: error.message });
      }
    },
  };
}

const ownerMappingController = createOwnerMappingController();

export { createOwnerMappingController };

export default ownerMappingController;
