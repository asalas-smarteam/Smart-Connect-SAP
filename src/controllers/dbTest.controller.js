import { ClientConfig } from '../config/database.js';
import { testExternalConnection } from '../utils/externalDb.js';

export const testExternalDb = async (req, reply) => {
  const { id: clientConfigId } = req.params;
  const config = await ClientConfig.findById(clientConfigId);

  if (!config) {
    return reply.send({ ok: false, message: 'ClientConfig not found' });
  }

  const result = await testExternalConnection(config);
  return reply.send(result);
};
