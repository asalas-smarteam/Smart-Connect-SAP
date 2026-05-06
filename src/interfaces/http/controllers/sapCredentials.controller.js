import { sapCredentialsReasons } from '#application/use-cases/ManageSapCredentials.js';
import buildManageSapCredentials from '#composition/sap-credentials.composition.js';
import requestTenantModelsAdapter from '#infrastructure/tenants/RequestTenantModelsAdapter.js';

function resolveFailureStatus(result) {
  if (
    result.reason === sapCredentialsReasons.INVALID_CLIENT_CONFIG_ID ||
    result.reason === sapCredentialsReasons.INVALID_CREDENTIALS_ID ||
    result.reason === sapCredentialsReasons.BAD_REQUEST
  ) {
    return 400;
  }

  if (
    result.reason === sapCredentialsReasons.CLIENT_CONFIG_NOT_FOUND ||
    result.reason === sapCredentialsReasons.SAP_CREDENTIALS_NOT_FOUND
  ) {
    return 404;
  }

  if (result.reason === sapCredentialsReasons.DUPLICATE) {
    return 409;
  }

  return 500;
}

function sendResult(reply, result) {
  if (result.ok) {
    const response = reply.code && result.statusCode ? reply.code(result.statusCode) : reply;
    return response.send({ ok: true, data: result.data });
  }

  return reply.code(resolveFailureStatus(result)).send({
    ok: false,
    message: result.message,
  });
}

function createSapCredentialsController({
  manageSapCredentials = buildManageSapCredentials(),
  tenantModelsResolver = requestTenantModelsAdapter,
} = {}) {
  return {
    async createSapCredentials(req, reply) {
      try {
        const result = await manageSapCredentials.create({
          tenantModels: tenantModelsResolver.resolve(req),
          payload: req.body,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ ok: false, message: error.message });
      }
    },

    async listSapCredentials(req, reply) {
      try {
        const result = await manageSapCredentials.list({
          tenantModels: tenantModelsResolver.resolve(req),
          query: req.query,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ ok: false, message: error.message });
      }
    },

    async getSapCredentials(req, reply) {
      try {
        const result = await manageSapCredentials.get({
          tenantModels: tenantModelsResolver.resolve(req),
          id: req.params.id,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ ok: false, message: error.message });
      }
    },

    async patchSapCredentials(req, reply) {
      try {
        const result = await manageSapCredentials.patch({
          tenantModels: tenantModelsResolver.resolve(req),
          id: req.params.id,
          payload: req.body,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ ok: false, message: error.message });
      }
    },

    async deleteSapCredentials(req, reply) {
      try {
        const result = await manageSapCredentials.delete({
          tenantModels: tenantModelsResolver.resolve(req),
          id: req.params.id,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.code(500).send({ ok: false, message: error.message });
      }
    },
  };
}

const sapCredentialsController = createSapCredentialsController();

export { createSapCredentialsController };

export default sapCredentialsController;
