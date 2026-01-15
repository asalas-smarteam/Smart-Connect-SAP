import logger from '../core/logger.js';
import LogEntry from '../db/models/LogEntry.js';

export const echoTest = async (req, reply) => {
  const { body } = req;

  logger.info('Echo test received', body);

  await LogEntry.create({
    type: 'ECHO_TEST',
    payload: body,
    level: 'info',
  });

  return reply.send({ ok: true, body });
}
