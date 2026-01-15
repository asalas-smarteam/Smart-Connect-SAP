import { LogEntry } from '../config/database.js';

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
