import { Queue } from 'bullmq';
import { getSharedBullMQConnection } from '../lib/bullmqRedis.js';

export const SAP_SYNC_QUEUE_NAME = 'sap-sync';
export const SAP_SYNC_JOB_NAME = 'sap-sync-job';

const DEFAULT_ATTEMPTS = Number(process.env.SAP_SYNC_JOB_ATTEMPTS || 20);
const DEFAULT_BACKOFF_MS = Number(process.env.SAP_SYNC_JOB_BACKOFF_MS || 15000);
const DEFAULT_REMOVE_ON_COMPLETE = Number(process.env.SAP_SYNC_REMOVE_ON_COMPLETE || 100);
const DEFAULT_REMOVE_ON_FAIL = Number(process.env.SAP_SYNC_REMOVE_ON_FAIL || 500);

let sapSyncQueue = null;

export function buildScheduledJobId({ tenantKey, configId }) {
  return `sap-sync:${tenantKey}:${String(configId)}`;
}

export function buildManualJobId({ tenantKey, configId }) {
  return `sap-sync:manual:${tenantKey}:${String(configId)}:${Date.now()}`;
}

export function getSapSyncQueue() {
  if (sapSyncQueue) {
    return sapSyncQueue;
  }

  sapSyncQueue = new Queue(SAP_SYNC_QUEUE_NAME, {
    connection: getSharedBullMQConnection(),
    defaultJobOptions: {
      attempts: DEFAULT_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: DEFAULT_BACKOFF_MS,
      },
      removeOnComplete: {
        count: DEFAULT_REMOVE_ON_COMPLETE,
      },
      removeOnFail: {
        count: DEFAULT_REMOVE_ON_FAIL,
      },
    },
  });

  return sapSyncQueue;
}

export function buildSapSyncPayload({ tenantKey, configId, objectType, triggerType = 'scheduled' }) {
  return {
    tenantKey,
    configId: String(configId),
    objectType: objectType || null,
    triggerType,
  };
}

export async function addManualSapSyncJob(payload) {
  const queue = getSapSyncQueue();
  return queue.add(SAP_SYNC_JOB_NAME, buildSapSyncPayload({ ...payload, triggerType: 'manual' }), {
    jobId: buildManualJobId(payload),
  });
}

export async function addScheduledSapSyncJob({ tenantKey, configId, objectType, intervalMinutes }) {
  const queue = getSapSyncQueue();

  return queue.add(
    SAP_SYNC_JOB_NAME,
    buildSapSyncPayload({
      tenantKey,
      configId,
      objectType,
      triggerType: 'scheduled',
    }),
    {
      jobId: buildScheduledJobId({ tenantKey, configId }),
      repeat: {
        every: Number(intervalMinutes) * 60 * 1000,
      },
    }
  );
}

export async function closeSapSyncQueue() {
  if (!sapSyncQueue) {
    return;
  }

  await sapSyncQueue.close();
  sapSyncQueue = null;
}
