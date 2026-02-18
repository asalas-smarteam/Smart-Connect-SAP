import { testExternalConnection } from '../utils/externalDb.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export const testExternalDb = async (req, reply) => {
  const { id: clientConfigId } = req.params;
  const { ClientConfig } = requireTenantModels(req);
  const config = await ClientConfig.findById(clientConfigId);

  if (!config) {
    return reply.send({ ok: false, message: 'ClientConfig not found' });
  }

  const result = await testExternalConnection(config);
  return reply.send(result);
};
