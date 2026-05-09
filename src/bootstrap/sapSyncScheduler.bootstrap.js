import logger from '#infrastructure/logger/logger.js';
import { bootstrapScheduledJobs } from '#infrastructure/scheduler/sapSyncScheduler.service.js';

export async function bootstrapSapSyncScheduler() {
  try {
    const summary = await bootstrapScheduledJobs({ upsertExisting: true });
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
