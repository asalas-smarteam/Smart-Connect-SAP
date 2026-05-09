function normalizeNumber(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

export const sapSyncQueueConfig = Object.freeze({
  queueName: 'sap-sync',
  jobName: 'sap-sync-job',
  attempts: normalizeNumber(process.env.SAP_SYNC_JOB_ATTEMPTS, 20),
  backoffMs: normalizeNumber(process.env.SAP_SYNC_JOB_BACKOFF_MS, 15000),
  removeOnComplete: normalizeNumber(process.env.SAP_SYNC_REMOVE_ON_COMPLETE, 100),
  removeOnFail: normalizeNumber(process.env.SAP_SYNC_REMOVE_ON_FAIL, 500),
  workerConcurrency: normalizeNumber(process.env.SAP_SYNC_WORKER_CONCURRENCY, 5),
});

export const webhookQueueConfig = Object.freeze({
  queueName: 'webhook-events',
  jobName: 'webhook-tenant-job',
  attempts: normalizeNumber(process.env.WEBHOOK_JOB_ATTEMPTS, 1),
  backoffMs: normalizeNumber(process.env.WEBHOOK_JOB_BACKOFF_MS, 15000),
  removeOnComplete: normalizeNumber(process.env.WEBHOOK_REMOVE_ON_COMPLETE, 100),
  removeOnFail: normalizeNumber(process.env.WEBHOOK_REMOVE_ON_FAIL, 500),
  workerConcurrency: normalizeNumber(process.env.WEBHOOK_WORKER_CONCURRENCY, 2),
});

export default Object.freeze({
  sapSync: sapSyncQueueConfig,
  webhook: webhookQueueConfig,
});

