import { clientConfigReasons } from '#application/use-cases/ManageClientConfigs.js';
import buildManageClientConfigs from '#composition/client-configs.composition.js';
import logger from '#infrastructure/logger/logger.js';
import requestTenantModelsAdapter from '#infrastructure/tenants/RequestTenantModelsAdapter.js';

function statusFor(result) {
  if (result.reason === clientConfigReasons.BAD_REQUEST) {
    return 400;
  }

  if (result.reason === clientConfigReasons.FORBIDDEN) {
    return 403;
  }

  if (result.reason === clientConfigReasons.NOT_FOUND) {
    return 404;
  }

  return 500;
}

function sendResult(reply, result) {
  if (result.ok) {
    return reply.send({ ok: true, data: result.data });
  }

  return reply.code(statusFor(result)).send({
    ok: false,
    message: result.message,
  });
}

function createConfigController({
  manageClientConfigs = buildManageClientConfigs(),
  tenantModelsResolver = requestTenantModelsAdapter,
} = {}) {
  return {
    createClientConfig: async (req, reply) => {
      try {
        const result = await manageClientConfigs.createClientConfig({
          tenantModels: tenantModelsResolver.resolve(req),
          tenantKey: req.tenantKey,
          payload: req.body,
        });
        return sendResult(reply, result);
      } catch (error) {
        logger.error({ msg: 'Failed creating ClientConfig', error: error.message });
        return reply.code(500).send({ ok: false, message: error.message });
      }
    },

    getClientConfig: async (req, reply) => {
      try {
        const result = await manageClientConfigs.listClientConfigs({
          tenantModels: tenantModelsResolver.resolve(req),
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.send({ ok: false, message: error.message });
      }
    },

    createIntegrationMode: async (req, reply) => {
      try {
        const result = await manageClientConfigs.createIntegrationMode({
          tenantModels: tenantModelsResolver.resolve(req),
          payload: req.body,
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.send({ ok: false, message: error.message });
      }
    },

    getIntegrationModes: async (req, reply) => {
      try {
        const result = await manageClientConfigs.listIntegrationModes({
          tenantModels: tenantModelsResolver.resolve(req),
        });
        return sendResult(reply, result);
      } catch (error) {
        return reply.send({ ok: false, message: error.message });
      }
    },

    patchClientConfig: async (req, reply) => {
      try {
        const result = await manageClientConfigs.patchClientConfig({
          tenantModels: tenantModelsResolver.resolve(req),
          tenantKey: req.tenantKey,
          id: req.params.id,
          payload: req.body,
        });
        return sendResult(reply, result);
      } catch (error) {
        logger.error({ msg: 'Failed patching ClientConfig', error: error.message });
        return reply.code(500).send({ ok: false, message: error.message });
      }
    },
  };
}

const configController = createConfigController();

export const {
  createClientConfig,
  getClientConfig,
  createIntegrationMode,
  getIntegrationModes,
  patchClientConfig,
} = configController;

export { createConfigController };

export default configController;
