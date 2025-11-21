import winston from 'winston';
import DataTypes from 'sequelize';
import sequelize from '../config/database.js';
import defineLogEntry from '../db/models/logEntry.js';

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
    new winston.transports.File({ filename: 'logs/app.log' }),
    new LogEntryTransport({ level: 'debug' }),
  ],
});

export default logger;
