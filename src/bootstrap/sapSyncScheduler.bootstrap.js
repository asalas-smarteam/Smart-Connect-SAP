import logger from '../core/logger.js';
import { bootstrapScheduledJobs } from '../services/scheduler/sapSyncScheduler.service.js';

export async function bootstrapSapSyncScheduler() {
  try {
    const summary = await bootstrapScheduledJobs();
    logger.info({
      msg: 'SAP sync scheduler bootstrap summary',
      ...summary,
    });
    return summary;
  } catch (error) {
    logger.error({
      msg: 'SAP sync scheduler bootstrap failed',
      error: error.message,
    });
    return null;
  }
}
