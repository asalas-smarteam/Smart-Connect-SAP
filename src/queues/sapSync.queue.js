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

export function buildSapSyncPayload({
  tenantKey,
  configId,
  objectType,
  mode,
  intervalMinutes,
  executionTime,
  triggerType = 'scheduled',
}) {
  const normalizedInterval = Number(intervalMinutes);
  return {
    tenantKey,
    configId: String(configId),
    objectType: objectType || null,
    mode: mode || null,
    intervalMinutes: Number.isFinite(normalizedInterval) && normalizedInterval > 0 ? normalizedInterval : null,
    executionTime: executionTime || null,
    triggerType,
  };
}

export async function addManualSapSyncJob(payload) {
  const queue = getSapSyncQueue();
  return queue.add(SAP_SYNC_JOB_NAME, buildSapSyncPayload({ ...payload, triggerType: 'manual' }), {
    jobId: buildManualJobId(payload),
  });
}

export async function addScheduledSapSyncJob({
  tenantKey,
  configId,
  objectType,
  mode,
  intervalMinutes,
  executionTime,
  repeatEvery,
  repeatPattern,
  repeatTimezone,
}) {
  const queue = getSapSyncQueue();
  const repeat = {};
  if (Number.isFinite(Number(repeatEvery)) && Number(repeatEvery) > 0) {
    repeat.every = Number(repeatEvery);
  } else if (typeof repeatPattern === 'string' && repeatPattern.trim()) {
    repeat.pattern = repeatPattern.trim();
    if (typeof repeatTimezone === 'string' && repeatTimezone.trim()) {
      repeat.tz = repeatTimezone.trim();
    }
  } else {
    throw new Error('repeatEvery or repeatPattern is required');
  }

  repeat.key = buildScheduledJobId({ tenantKey, configId });

  return queue.add(
    SAP_SYNC_JOB_NAME,
    buildSapSyncPayload({
      tenantKey,
      configId,
      objectType,
      mode,
      intervalMinutes,
      executionTime,
      triggerType: 'scheduled',
    }),
    {
      jobId: buildScheduledJobId({ tenantKey, configId }),
      repeat,
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
