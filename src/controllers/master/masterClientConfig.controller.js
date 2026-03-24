import { FeatureFlags } from '../../config/database.js';
import {
  createMasterClientConfig,
  deleteMasterClientConfig,
  listMasterClientConfigs,
  patchMasterClientConfig,
} from '../../services/master/masterClientConfig.service.js';

function resolveStatusCode(error) {
  if (/Missing required fields|intervalMinutes/.test(error.message)) {
    return 400;
  }

  return 500;
}

export async function getMasterClientConfigs(req, reply) {
  try {
    const data = await listMasterClientConfigs(FeatureFlags.db);
    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.code(500).send({ ok: false, message: error.message });
  }
}

export async function createMasterClientConfigHandler(req, reply) {
  try {
    const data = await createMasterClientConfig(FeatureFlags.db, req.body);
    return reply.send({ ok: true, data });
  } catch (error) {
    return reply.code(resolveStatusCode(error)).send({
      ok: false,
      message: error.message,
    });
  }
}

export async function patchMasterClientConfigHandler(req, reply) {
  try {
    const { id } = req.params;
    const data = await patchMasterClientConfig(FeatureFlags.db, id, req.body);

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
}

export async function deleteMasterClientConfigHandler(req, reply) {
  try {
    const { id } = req.params;
    const deleted = await deleteMasterClientConfig(FeatureFlags.db, id);

    if (!deleted) {
      return reply.code(404).send({ ok: false, message: 'Master ClientConfig not found' });
    }

    return reply.send({ ok: true, data: deleted });
  } catch (error) {
    return reply.code(500).send({ ok: false, message: error.message });
  }
}
