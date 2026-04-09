import logger from '../core/logger.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export const echoTest = async (req, reply) => {
  const { body } = req;

  logger.info('Echo test received', body);

  return reply.send({ ok: true, body });
};
