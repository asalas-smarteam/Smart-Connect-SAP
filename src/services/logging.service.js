import DataTypes from 'sequelize';
import database from '../config/database.js';
import defineLogEntry from '../db/models/LogEntry.js';

const LogEntry = defineLogEntry(database, DataTypes);

const loggingService = {
  async logEvent(type, payload, level = 'info') {
    try {
      await LogEntry.create({
        type,
        payload,
        level,
      });
    } catch (error) {
      console.error('Failed to log event:', error);
    }
  },
};

export default loggingService;
