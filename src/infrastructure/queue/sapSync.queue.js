import { Queue } from 'bullmq';
import { getSharedBullMQConnection } from './bullmqRedis.js';

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

function buildRepeatOptions({ repeatEvery, repeatPattern, repeatTimezone }) {
  if (Number.isFinite(Number(repeatEvery)) && Number(repeatEvery) > 0) {
    return { every: Number(repeatEvery) };
  }

  if (typeof repeatPattern === 'string' && repeatPattern.trim()) {
    return {
      pattern: repeatPattern.trim(),
      ...(typeof repeatTimezone === 'string' && repeatTimezone.trim()
        ? { tz: repeatTimezone.trim() }
        : {}),
    };
  }

  throw new Error('repeatEvery or repeatPattern is required');
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
  executionDays,
  startTime,
  endTime,
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
    executionDays: Array.isArray(executionDays) ? executionDays : [],
    startTime: startTime || null,
    endTime: endTime || null,
    triggerType,
  };
}

export async function addManualSapSyncJob(payload) {
  const queue = getSapSyncQueue();
  return queue.add(SAP_SYNC_JOB_NAME, buildSapSyncPayload({ ...payload, triggerType: 'manual' }), {
    jobId: buildManualJobId(payload),
  });
}

export function buildScheduledSapSyncJobTemplate({
  tenantKey,
  configId,
  objectType,
  mode,
  intervalMinutes,
  executionTime,
  executionDays,
  startTime,
  endTime,
  repeatEvery,
  repeatPattern,
  repeatTimezone,
}) {
  const schedulerId = buildScheduledJobId({ tenantKey, configId });
  const repeatOptions = buildRepeatOptions({ repeatEvery, repeatPattern, repeatTimezone });

  return {
    schedulerId,
    repeatOptions,
    jobTemplate: {
      name: SAP_SYNC_JOB_NAME,
      data: buildSapSyncPayload({
        tenantKey,
        configId,
        objectType,
        mode,
        intervalMinutes,
        executionTime,
        executionDays,
        startTime,
        endTime,
        triggerType: 'scheduled',
      }),
    },
  };
}

export async function addScheduledSapSyncJob(schedule) {
  const queue = getSapSyncQueue();
  const { schedulerId, repeatOptions, jobTemplate } = buildScheduledSapSyncJobTemplate(schedule);

  return queue.upsertJobScheduler(schedulerId, repeatOptions, jobTemplate);
}

export async function removeScheduledSapSyncJobScheduler(schedulerId) {
  if (!schedulerId) {
    return false;
  }

  const queue = getSapSyncQueue();
  if (typeof queue.removeJobScheduler !== 'function') {
    return false;
  }

  return queue.removeJobScheduler(schedulerId);
}

export async function getSapSyncJobSchedulers() {
  const queue = getSapSyncQueue();
  if (typeof queue.getJobSchedulers !== 'function') {
    return [];
  }

  return queue.getJobSchedulers();
}

export async function closeSapSyncQueue() {
  if (!sapSyncQueue) {
    return;
  }

  await sapSyncQueue.close();
  sapSyncQueue = null;
}
