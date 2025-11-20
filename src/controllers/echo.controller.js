const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const logger = require('../core/logger');
const defineLogEntry = require('../db/models/LogEntry');

const LogEntry = defineLogEntry(sequelize, DataTypes);

async function echoTest(req, reply) {
  const { body } = req;

  logger.info('Echo test received', body);

  await LogEntry.create({
    type: 'ECHO_TEST',
    payload: body,
    level: 'info',
  });

  return reply.send({ ok: true, body });
}

module.exports = { echoTest };
