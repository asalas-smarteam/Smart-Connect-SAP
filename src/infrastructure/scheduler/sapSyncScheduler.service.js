import logger from '../logger/logger.js';
import crypto from 'crypto';
import { getTenantModels } from '../database/tenant/tenantDatabase.js';
import { listActiveTenants } from '../tenants/tenantSubscriptions.js';
import {
  addScheduledSapSyncJob,
  buildScheduledJobId,
  SAP_SYNC_JOB_NAME,
  getSapSyncQueue,
} from '../queue/sapSync.queue.js';

const SAP_SYNC_SCHEDULER_TIMEZONE = 'America/Costa_Rica';
const WEEKDAY_TO_CRON = Object.freeze({
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
});
const WEEKDAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

function normalizeIntervalMinutes(intervalMinutes) {
  const value = Number(intervalMinutes);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function normalizeMode(mode) {
  const value = String(mode || 'INCREMENTAL').trim().toUpperCase();
  if (value === 'FULL' || value === 'INCREMENTAL') {
    return value;
  }
  return 'INCREMENTAL';
}

function parseTime(value) {
  const normalized = String(value || '').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(normalized);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return { value: normalized, hours, minutes, totalMinutes: hours * 60 + minutes };
}

function normalizeExecutionDays(executionDays) {
  if (!Array.isArray(executionDays) || executionDays.length === 0) {
    return [];
  }

  const days = [];
  for (const day of executionDays) {
    const key = String(day || '').trim().toLowerCase();
    if (!Object.hasOwn(WEEKDAY_TO_CRON, key)) {
      return null;
    }
    days.push(WEEKDAY_TO_CRON[key]);
  }

  return Array.from(new Set(days)).sort((left, right) => left - right);
}

function normalizeExecutionDayNames(executionDays) {
  const days = normalizeExecutionDays(executionDays);
  if (days === null) {
    return null;
  }

  return days.map((day) => WEEKDAY_NAMES[day]);
}

function buildDailyPattern({ executionTime, executionDays }) {
  const value = String(executionTime || '').trim();
  const time = parseTime(value);
  const days = normalizeExecutionDays(executionDays);
  if (!time || days === null) {
    return null;
  }

  const dayPattern = days.length ? days.join(',') : '*';
  return `${time.minutes} ${time.hours} * * ${dayPattern}`;
}

function buildHourField(start, end) {
  if (!start || !end) {
    return '*';
  }

  if (start.hours === end.hours) {
    return String(start.hours);
  }

  if (start.totalMinutes < end.totalMinutes) {
    return `${start.hours}-${end.hours}`;
  }

  return `${start.hours}-23,0-${end.hours}`;
}

function buildMinuteField({ intervalMinutes, start }) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || intervalMinutes > 60) {
    return null;
  }

  const offset = start ? start.minutes % intervalMinutes : 0;
  const minutes = [];
  for (let minute = offset; minute < 60; minute += intervalMinutes) {
    minutes.push(minute);
  }

  return minutes.join(',');
}

function buildIncrementalWindowPattern({ intervalMinutes, startTime, endTime }) {
  const hasStart = Boolean(startTime);
  const hasEnd = Boolean(endTime);
  if (!hasStart && !hasEnd) {
    return null;
  }

  if (!hasStart || !hasEnd) {
    return null;
  }

  const start = parseTime(startTime);
  const end = parseTime(endTime);
  if (!start || !end) {
    return null;
  }

  const minuteField = buildMinuteField({ intervalMinutes, start });
  if (!minuteField) {
    return null;
  }

  return {
    startTime: start.value,
    endTime: end.value,
    repeatPattern: `${minuteField} ${buildHourField(start, end)} * * *`,
  };
}

function resolveSchedulePlan(config) {
  const mode = normalizeMode(config?.mode);
  const intervalMinutes = normalizeIntervalMinutes(config?.intervalMinutes);
  const executionTime = String(config?.executionTime || '').trim() || null;
  const executionDayNames = normalizeExecutionDayNames(config?.executionDays);
  const cronPattern = buildDailyPattern({ executionTime, executionDays: config?.executionDays });
  const startTime = String(config?.startTime || '').trim() || null;
  const endTime = String(config?.endTime || '').trim() || null;

  if (mode === 'FULL') {
    if (!cronPattern) {
      return null;
    }
    return {
      mode,
      intervalMinutes: null,
      executionTime,
      executionDays: executionDayNames || [],
      startTime: null,
      endTime: null,
      repeatEvery: null,
      repeatPattern: cronPattern,
      repeatTimezone: SAP_SYNC_SCHEDULER_TIMEZONE,
    };
  }

  if (!intervalMinutes) {
    return null;
  }

  const windowPattern = buildIncrementalWindowPattern({ intervalMinutes, startTime, endTime });
  if (startTime || endTime) {
    if (!windowPattern) {
      return null;
    }

    return {
      mode,
      intervalMinutes,
      executionTime: null,
      executionDays: [],
      startTime: windowPattern.startTime,
      endTime: windowPattern.endTime,
      repeatEvery: null,
      repeatPattern: windowPattern.repeatPattern,
      repeatTimezone: SAP_SYNC_SCHEDULER_TIMEZONE,
    };
  }

  return {
    mode,
    intervalMinutes,
    executionTime: null,
    executionDays: [],
    startTime: null,
    endTime: null,
    repeatEvery: intervalMinutes * 60 * 1000,
    repeatPattern: null,
    repeatTimezone: null,
  };
}

function isRepeatableScheduledJob(repeatJob) {
  return (
    typeof repeatJob?.key === 'string'
    && (
      repeatJob.key.startsWith('sap-sync:')
      || repeatJob.name === SAP_SYNC_JOB_NAME
    )
  );
}

function isScheduledJobEntry(job) {
  return (
    isRepeatableScheduledJob(job)
    || typeof job?.id === 'string' && job.id.startsWith('sap-sync:')
  );
}

function matchesScheduledJobKeys(job, keys) {
  return keys.has(job?.key) || (typeof job?.id === 'string' && keys.has(job.id));
}

async function getCurrentScheduledJobs(queue) {
  const [repeatableJobs, rawJobSchedulers] = await Promise.all([
    typeof queue.getRepeatableJobs === 'function' ? queue.getRepeatableJobs() : [],
    typeof queue.getJobSchedulers === 'function' ? queue.getJobSchedulers() : [],
  ]);
  const jobSchedulers = rawJobSchedulers.filter((job) => job?.template);
  const schedulerKeys = new Set(jobSchedulers.map((job) => job.key).filter(Boolean));
  const legacyRepeatableJobs = repeatableJobs.filter((job) => !schedulerKeys.has(job?.key));

  return {
    repeatableJobs: legacyRepeatableJobs,
    jobSchedulers,
    all: [...legacyRepeatableJobs, ...jobSchedulers],
  };
}

function buildLegacyRepeatableKey({ jobId, repeatEvery, repeatPattern, repeatTimezone = '' }) {
  const suffix = repeatPattern || String(repeatEvery || '');
  const repeatConcatOptions = `${SAP_SYNC_JOB_NAME}:${jobId}::${repeatTimezone}:${suffix}`;
  return crypto.createHash('md5').update(repeatConcatOptions).digest('hex');
}

function buildRemovalKeyCandidates({ jobId, config }) {
  const schedulePlan = resolveSchedulePlan(config);
  const keys = new Set([jobId]);

  if (!schedulePlan) {
    return Array.from(keys);
  }

  keys.add(buildLegacyRepeatableKey({
    jobId,
    repeatEvery: schedulePlan.repeatEvery,
    repeatPattern: schedulePlan.repeatPattern,
  }));

  if (schedulePlan.repeatPattern) {
    keys.add(buildLegacyRepeatableKey({
      jobId,
      repeatEvery: schedulePlan.repeatEvery,
      repeatPattern: schedulePlan.repeatPattern,
      repeatTimezone: schedulePlan.repeatTimezone || '',
    }));
  }

  return Array.from(keys);
}

async function removeScheduledRepeatablesByKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) {
    return 0;
  }

  const queue = getSapSyncQueue();
  const { repeatableJobs, jobSchedulers } = await getCurrentScheduledJobs(queue);
  const knownKeys = new Set(keys.filter(Boolean));
  const repeatableCandidates = repeatableJobs.filter((job) => matchesScheduledJobKeys(job, knownKeys));
  const schedulerCandidates = jobSchedulers.filter((job) => matchesScheduledJobKeys(job, knownKeys));

  await Promise.all([
    ...repeatableCandidates.map((job) => queue.removeRepeatableByKey(job.key)),
    ...schedulerCandidates.map((job) => queue.removeJobScheduler(job.key || job.id)),
  ]);

  return repeatableCandidates.length + schedulerCandidates.length;
}

async function removeKnownScheduledJobs({ tenantKey, configId, config, previousConfig }) {
  if (!tenantKey || !configId) {
    throw new Error('tenantKey and configId are required');
  }

  const jobId = buildScheduledJobId({ tenantKey, configId });
  const keys = new Set(buildRemovalKeyCandidates({ jobId, config }));

  if (previousConfig) {
    for (const key of buildRemovalKeyCandidates({ jobId, config: previousConfig })) {
      keys.add(key);
    }
  }

  const removedCount = await removeScheduledRepeatablesByKeys(Array.from(keys));
  return { jobId, removedCount };
}

async function createScheduledJob({ tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  const schedulePlan = resolveSchedulePlan(config);
  const objectType = config?.objectType || null;

  if (!tenantKey || !configId || !schedulePlan) {
    throw new Error('tenantKey, configId and valid schedule config are required');
  }

  await addScheduledSapSyncJob({
    tenantKey,
    configId,
    objectType,
    mode: schedulePlan.mode,
    intervalMinutes: schedulePlan.intervalMinutes,
    executionTime: schedulePlan.executionTime,
    executionDays: schedulePlan.executionDays,
    startTime: schedulePlan.startTime,
    endTime: schedulePlan.endTime,
    repeatEvery: schedulePlan.repeatEvery,
    repeatPattern: schedulePlan.repeatPattern,
    repeatTimezone: schedulePlan.repeatTimezone,
  });

  return {
    jobId: buildScheduledJobId({ tenantKey, configId }),
    configId,
    objectType,
    schedulePlan,
  };
}

function hasScheduledJob({ scheduledJobs, tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  if (!tenantKey || !configId || !Array.isArray(scheduledJobs)) {
    return false;
  }

  const jobId = buildScheduledJobId({ tenantKey, configId });
  const candidateKeys = new Set(buildRemovalKeyCandidates({ jobId, config }));

  return scheduledJobs.some((job) => matchesScheduledJobKeys(job, candidateKeys));
}

export async function registerScheduledJob({ tenantKey, config, previousConfig = null }) {
  const nextConfigId = String(config?._id || config?.id || '');
  const { jobId, removedCount } = await removeKnownScheduledJobs({
    tenantKey,
    configId: nextConfigId,
    config,
    previousConfig,
  });
  const { configId, objectType, schedulePlan } = await createScheduledJob({ tenantKey, config });

  logger.info({
    msg: 'Scheduled SAP sync job registered',
    tenantKey,
    configId,
    objectType,
    mode: schedulePlan.mode,
    intervalMinutes: schedulePlan.intervalMinutes,
    executionTime: schedulePlan.executionTime,
    executionDays: schedulePlan.executionDays,
    startTime: schedulePlan.startTime,
    endTime: schedulePlan.endTime,
    repeatEvery: schedulePlan.repeatEvery,
    repeatPattern: schedulePlan.repeatPattern,
    repeatTimezone: schedulePlan.repeatTimezone,
    jobId,
    removedCount,
  });
}

export async function removeScheduledJob({ tenantKey, configId, config = null, previousConfig = null }) {
  if (!tenantKey || !configId) {
    throw new Error('tenantKey and configId are required');
  }

  const { jobId, removedCount } = await removeKnownScheduledJobs({
    tenantKey,
    configId: String(configId),
    config,
    previousConfig,
  });

  logger.info({
    msg: 'Scheduled SAP sync job removed',
    tenantKey,
    configId: String(configId),
    jobId,
    removedCount,
  });
}

export async function syncScheduledJob({ tenantKey, config, previousConfig = null }) {
  const configId = String(config?._id || config?.id || '');
  const schedulePlan = resolveSchedulePlan(config);
  const shouldSchedule = Boolean(config?.active) && Boolean(schedulePlan);

  if (!tenantKey || !configId) {
    throw new Error('tenantKey and config are required');
  }

  if (shouldSchedule) {
    await registerScheduledJob({ tenantKey, config, previousConfig });
    return { action: 'registered' };
  }

  await removeScheduledJob({ tenantKey, configId, config, previousConfig });
  return { action: 'removed' };
}

export async function bootstrapScheduledJobs({ upsertExisting = false } = {}) {
  const queue = getSapSyncQueue();
  const scheduledJobs = await getCurrentScheduledJobs(queue);
  const expectedJobKeys = new Set();
  const activeTenants = await listActiveTenants();
  const summary = {
    tenantsScanned: 0,
    configsScheduled: 0,
    configsSkippedExisting: 0,
    configsSkippedInactive: 0,
    configsRemoved: 0,
    tenantErrors: [],
    orphanRemoved: 0,
  };

  for (const { client } of activeTenants) {
    summary.tenantsScanned += 1;
    const tenantKey = client.tenantKey;

    try {
      const tenantModels = await getTenantModels(tenantKey);
      const { ClientConfig } = tenantModels;
      const configs = await ClientConfig.find({}).lean();

      for (const config of configs) {
        const configId = String(config._id);
        const jobKey = buildScheduledJobId({ tenantKey, configId });
        const schedulePlan = resolveSchedulePlan(config);

        if (config.active && schedulePlan) {
          if (upsertExisting) {
            expectedJobKeys.add(jobKey);
            await registerScheduledJob({ tenantKey, config });
            summary.configsScheduled += 1;
            continue;
          }

          if (hasScheduledJob({ scheduledJobs: scheduledJobs.all, tenantKey, config })) {
            summary.configsSkippedExisting += 1;
            continue;
          }

          await createScheduledJob({ tenantKey, config });
          scheduledJobs.all.push({
            key: jobKey,
            id: jobKey,
            name: SAP_SYNC_JOB_NAME,
          });
          summary.configsScheduled += 1;
        } else {
          if (upsertExisting) {
            await removeScheduledJob({ tenantKey, configId, config });
            summary.configsRemoved += 1;
          } else {
            summary.configsSkippedInactive += 1;
          }
        }
      }
    } catch (error) {
      summary.tenantErrors.push({
        tenantKey,
        error: error.message,
      });
      logger.error({
        msg: 'SAP sync scheduler bootstrap failed for tenant',
        tenantKey,
        error: error.message,
      });
    }
  }

  if (upsertExisting && summary.tenantsScanned > 0) {
    try {
      const latestScheduledJobs = await getCurrentScheduledJobs(queue);
      const orphanedJobs = latestScheduledJobs.all.filter(
        (job) => isScheduledJobEntry(job) && !matchesScheduledJobKeys(job, expectedJobKeys)
      );

      for (const job of orphanedJobs) {
        if (latestScheduledJobs.jobSchedulers.includes(job)) {
          await queue.removeJobScheduler(job.key || job.id);
        } else {
          await queue.removeRepeatableByKey(job.key);
        }
        summary.orphanRemoved += 1;
        logger.info({
          msg: 'Removed orphan SAP sync scheduled job',
          repeatJobKey: job.key,
          jobId: job.id || null,
        });
      }
    } catch (error) {
      logger.error({
        msg: 'Failed while removing orphan SAP sync repeatable jobs',
        error: error.message,
      });
    }
  }

  logger.info({
    msg: 'SAP sync scheduler bootstrap completed',
    ...summary,
  });

  return summary;
}

export async function removeTenantScheduledJobs(tenantKey) {
  if (!tenantKey) {
    throw new Error('tenantKey is required');
  }

  const queue = getSapSyncQueue();
  const { repeatableJobs, jobSchedulers } = await getCurrentScheduledJobs(queue);
  const tenantPrefix = `sap-sync:${tenantKey}:`;
  const tenantJobs = repeatableJobs.filter((job) => job?.key?.startsWith(tenantPrefix));
  const tenantSchedulers = jobSchedulers.filter(
    (job) => job?.key?.startsWith(tenantPrefix) || job?.id?.startsWith(tenantPrefix)
  );

  await Promise.all([
    ...tenantJobs.map((job) => queue.removeRepeatableByKey(job.key)),
    ...tenantSchedulers.map((job) => queue.removeJobScheduler(job.key || job.id)),
  ]);
  return tenantJobs.length + tenantSchedulers.length;
}
