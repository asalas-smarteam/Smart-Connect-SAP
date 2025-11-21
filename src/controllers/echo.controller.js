import DataTypes from 'sequelize';
import sequelize from '../config/database.js';
import logger from '../core/logger.js';
import defineLogEntry from '../db/models/logEntry.js';

const LogEntry = defineLogEntry(sequelize, DataTypes);

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