const winston = require('winston');
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const defineLogEntry = require('../db/models/LogEntry');

const LogEntry = defineLogEntry(sequelize, DataTypes);

const customLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const fallbackLogger = winston.createLogger({
  level: 'error',
  transports: [new winston.transports.Console({ level: 'error' })],
});

class LogEntryTransport extends winston.Transport {
  constructor(options = {}) {
    super(options);
    this.level = options.level || 'debug';
  }

  async log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    const { level, message, ...meta } = info;

    try {
      await LogEntry.create({
        type: 'WINSTON',
        payload: { message, meta },
        level,
      });
    } catch (error) {
      fallbackLogger.error('Failed to persist log entry:', error);
    }

    if (callback) {
      callback();
    }
  }
}

const logger = winston.createLogger({
  levels: customLevels,
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ level: 'info' }),
    new LogEntryTransport({ level: 'debug' }),
  ],
});

module.exports = logger;
