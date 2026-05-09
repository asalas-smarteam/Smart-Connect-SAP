import { runSapSyncOnce } from '#interfaces/jobs/tasks/sapSyncTask.js';
import { runWebhookProcessorManualOnce } from '#interfaces/jobs/tasks/webhookProcessorTask.js';
import {
  getQueueDashboardSnapshot,
  purgeTenantJobs,
  resyncSchedulerFromDatabase,
  runConfigManualJob,
  setConfigActiveState,
  syncSingleConfigSchedule,
} from './sapSyncQueueAdmin.service.js';

export class SapSyncAdminAdapter {
  runSapSyncOnce() {
    return runSapSyncOnce();
  }

  runWebhookProcessorManualOnce() {
    return runWebhookProcessorManualOnce();
  }

  getQueueDashboardSnapshot() {
    return getQueueDashboardSnapshot();
  }

  setConfigActiveState(payload) {
    return setConfigActiveState(payload);
  }

  runConfigManualJob(payload) {
    return runConfigManualJob(payload);
  }

  resyncSchedulerFromDatabase() {
    return resyncSchedulerFromDatabase();
  }

  purgeTenantJobs(tenantKey) {
    return purgeTenantJobs(tenantKey);
  }

  syncSingleConfigSchedule(payload) {
    return syncSingleConfigSchedule(payload);
  }
}

export const sapSyncAdminAdapter = new SapSyncAdminAdapter();

export default sapSyncAdminAdapter;
