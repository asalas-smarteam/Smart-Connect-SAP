import masterClientConfigAdapter from '../../../../infrastructure/config/MasterClientConfigAdapter.js';

function resolveStatusCode(error) {
  if (/Missing required fields|intervalMinutes|mode|executionTime|ValidationError/.test(error.message)) {
    return 400;
  }

  return 500;
}

function createMasterClientConfigController({
  masterClientConfig = masterClientConfigAdapter,
} = {}) {
  return {
    async getMasterClientConfigs(req, reply) {
  try {
    const data = await masterClientConfig.list();
    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.code(500).send({ ok: false, message: error.message });
  }
},

    async createMasterClientConfigHandler(req, reply) {
  try {
    const data = await masterClientConfig.create(req.body);
    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.code(resolveStatusCode(error)).send({
      ok: false,
      message: error.message,
    });
  }
},

    async patchMasterClientConfigHandler(req, reply) {
  try {
    const { id } = req.params;
    const data = await masterClientConfig.patch(id, req.body);

    if (!data) {
      return reply.code(404).send({ ok: false, message: 'Master ClientConfig not found' });
    }

    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.code(resolveStatusCode(error)).send({
      ok: false,
      message: error.message,
    });
  }
},

    async deleteMasterClientConfigHandler(req, reply) {
  try {
    const { id } = req.params;
    const deleted = await masterClientConfig.delete(id);

    if (!deleted) {
      return reply.code(404).send({ ok: false, message: 'Master ClientConfig not found' });
    }

    return reply.send({ ok: true, data: deleted });
  } catch (error) {
    return reply.code(500).send({ ok: false, message: error.message });
  }
},
  };
}

const masterClientConfigController = createMasterClientConfigController();

export const {
  createMasterClientConfigHandler,
  deleteMasterClientConfigHandler,
  getMasterClientConfigs,
  patchMasterClientConfigHandler,
} = masterClientConfigController;

export { createMasterClientConfigController };

export default masterClientConfigController;
