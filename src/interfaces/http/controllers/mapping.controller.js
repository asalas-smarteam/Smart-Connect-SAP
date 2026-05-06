import ManageFieldMappings, {
  fieldMappingReasons,
} from '../../../application/use-cases/ManageFieldMappings.js';
import FieldMappingService from '../../../application/services/field-mapping.service.js';
import TenantFieldMappingRepository from '../../../infrastructure/database/repositories/TenantFieldMappingRepository.js';
import TenantMappingManagementRepository from '../../../infrastructure/database/repositories/TenantMappingManagementRepository.js';
import { requireTenantModels } from '../../../utils/tenantModels.js';

function buildManageFieldMappings() {
  return new ManageFieldMappings({
    mappingManagementRepository: new TenantMappingManagementRepository(),
    fieldMappingService: new FieldMappingService({
      fieldMappingRepository: new TenantFieldMappingRepository(),
    }),
  });
}

function sendFailure(reply, result) {
  if (result.reason === fieldMappingReasons.DUPLICATE_MAPPING) {
    return reply.code(409).send({ ok: false, message: result.message });
  }

  if (
    result.reason === fieldMappingReasons.CLIENT_CONFIG_REQUIRED ||
    result.reason === fieldMappingReasons.SOURCE_CONTEXT_REQUIRED
  ) {
    return reply.code(400).send({ ok: false, message: result.message });
  }

  return reply.send({ ok: false, message: result.message });
}

export function createMappingController({
  manageFieldMappings = buildManageFieldMappings(),
} = {}) {
  return {
    createMapping: async (req, reply) => {
      try {
        const result = await manageFieldMappings.createTenantMapping({
          tenantModels: requireTenantModels(req),
          payload: req.body,
        });

        return result.ok ? reply.send(result) : sendFailure(reply, result);
      } catch (error) {
        return reply.send({ ok: false, message: error.message });
      }
    },

    createAdminMapping: async (req, reply) => {
      try {
        const result = await manageFieldMappings.createAdminMapping({
          tenantModels: requireTenantModels(req),
          payload: req.body,
        });

        return result.ok ? reply.send(result) : sendFailure(reply, result);
      } catch (error) {
        return reply.send({ ok: false, message: error.message });
      }
    },

    getMappings: async (req, reply) => {
      try {
        const result = await manageFieldMappings.listMappings({
          tenantModels: requireTenantModels(req),
          query: req.query,
        });

        return reply.send(result);
      } catch (error) {
        return reply.send({ ok: false, message: error.message });
      }
    },

    applyMappingTest: async (req, reply) => {
      try {
        const result = await manageFieldMappings.applyMappingTest({
          tenantModels: requireTenantModels(req),
          payload: req.body,
        });

        return reply.send(result);
      } catch (error) {
        return reply.send({ ok: false, message: error.message });
      }
    },
  };
}

const mappingController = createMappingController();

export const {
  createMapping,
  createAdminMapping,
  getMappings,
  applyMappingTest,
} = mappingController;

export default mappingController;
