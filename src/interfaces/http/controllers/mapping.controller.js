import { fieldMappingReasons } from '#application/use-cases/ManageFieldMappings.js';
import buildManageFieldMappings from '#composition/field-mappings.composition.js';
import requestTenantModelsAdapter from '#infrastructure/tenants/RequestTenantModelsAdapter.js';

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
  tenantModelsResolver = requestTenantModelsAdapter,
} = {}) {
  return {
    createMapping: async (req, reply) => {
      try {
        const result = await manageFieldMappings.createTenantMapping({
          tenantModels: tenantModelsResolver.resolve(req),
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
          tenantModels: tenantModelsResolver.resolve(req),
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
          tenantModels: tenantModelsResolver.resolve(req),
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
          tenantModels: tenantModelsResolver.resolve(req),
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
