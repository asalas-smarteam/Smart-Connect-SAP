import {
  SAP_SYNC_JOB_NAME,
  SAP_SYNC_QUEUE_NAME,
  addManualSapSyncJob,
  addScheduledSapSyncJob,
  buildManualJobId,
  buildSapSyncPayload,
  buildScheduledJobId,
  closeSapSyncQueue,
  getSapSyncQueue,
} from '../../queues/sapSync.queue.js';

export {
  SAP_SYNC_JOB_NAME,
  SAP_SYNC_QUEUE_NAME,
  addManualSapSyncJob,
  addScheduledSapSyncJob,
  buildManualJobId,
  buildSapSyncPayload,
  buildScheduledJobId,
  closeSapSyncQueue,
  getSapSyncQueue,
};

export const sapSyncQueueAdapter = Object.freeze({
  addManualJob: addManualSapSyncJob,
  addScheduledJob: addScheduledSapSyncJob,
  close: closeSapSyncQueue,
  getQueue: getSapSyncQueue,
});

export default sapSyncQueueAdapter;

