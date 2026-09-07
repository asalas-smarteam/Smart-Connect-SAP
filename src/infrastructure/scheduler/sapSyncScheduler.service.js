import logger from '../logger/logger.js';
import crypto from 'crypto';
import { MAX_EXECUTION_TIMES, normalizeExecutionTimes } from '#domain/sync/execution-times.js';
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

// Lee executionTime de un documento que puede venir de tres formas: array (lo normal a partir de
// ahora), string suelto (documentos anteriores a la migración, y también cualquier lectura hecha con
// .lean(), que NO pasa por el casteo de Mongoose) o null.
// No propaga la excepción a propósito: un documento con basura debe dejar esa config sin programar y
// con un log visible, no tumbar el bootstrap del resto del tenant.
function readExecutionTimes(config) {
  try {
    return normalizeExecutionTimes(config?.executionTime);
  } catch (error) {
    logger.error({
      msg: 'Invalid executionTime on ClientConfig, schedule skipped',
      configId: String(config?._id || config?.id || ''),
      executionTime: config?.executionTime,
      error: error.message,
    });
    return [];
  }
}

function buildDailyPatterns({ executionTimes, executionDays }) {
  const days = normalizeExecutionDays(executionDays);
  if (days === null || !executionTimes.length) {
    return null;
  }

  const dayPattern = days.length ? days.join(',') : '*';
  const patterns = [];

  for (const value of executionTimes) {
    const time = parseTime(value);
    if (!time) {
      return null;
    }

    patterns.push({
      executionTime: time.value,
      repeatPattern: `${time.minutes} ${time.hours} * * ${dayPattern}`,
    });
  }

  return patterns;
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
  const executionTimes = readExecutionTimes(config);
  const executionDayNames = normalizeExecutionDayNames(config?.executionDays);
  const startTime = String(config?.startTime || '').trim() || null;
  const endTime = String(config?.endTime || '').trim() || null;

  if (mode === 'FULL') {
    const patterns = buildDailyPatterns({ executionTimes, executionDays: config?.executionDays });
    if (!patterns) {
      return null;
    }

    return {
      mode,
      intervalMinutes: null,
      executionTimes,
      executionDays: executionDayNames || [],
      startTime: null,
      endTime: null,
      slots: patterns.map((pattern, slotIndex) => ({
        slotIndex,
        executionTime: pattern.executionTime,
        repeatEvery: null,
        repeatPattern: pattern.repeatPattern,
        repeatTimezone: SAP_SYNC_SCHEDULER_TIMEZONE,
      })),
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
      executionTimes: [],
      executionDays: [],
      startTime: windowPattern.startTime,
      endTime: windowPattern.endTime,
      slots: [{
        slotIndex: null,
        executionTime: null,
        repeatEvery: null,
        repeatPattern: windowPattern.repeatPattern,
        repeatTimezone: SAP_SYNC_SCHEDULER_TIMEZONE,
      }],
    };
  }

  return {
    mode,
    intervalMinutes,
    executionTimes: [],
    executionDays: [],
    startTime: null,
    endTime: null,
    slots: [{
      slotIndex: null,
      executionTime: null,
      repeatEvery: intervalMinutes * 60 * 1000,
      repeatPattern: null,
      repeatTimezone: null,
    }],
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

// La lista de nombres a borrar es FIJA, no derivada del estado anterior: el nombre plano (el que
// usaban las configs antes de multihora, y el que siguen usando las INCREMENTAL) más un nombre por
// cada slot posible. Por eso bajar de 3 horas a 1 limpia igual sin recibir previousConfig.
// Las claves md5 legacy (repeatable jobs de la API vieja de BullMQ) sí se derivan del plan, una por
// slot.
function buildRemovalKeyCandidates({ jobId, config }) {
  const keys = new Set([jobId]);

  for (let slotIndex = 0; slotIndex < MAX_EXECUTION_TIMES; slotIndex += 1) {
    keys.add(`${jobId}:${slotIndex}`);
  }

  const schedulePlan = resolveSchedulePlan(config);
  if (!schedulePlan) {
    return Array.from(keys);
  }

  for (const slot of schedulePlan.slots) {
    keys.add(buildLegacyRepeatableKey({
      jobId,
      repeatEvery: slot.repeatEvery,
      repeatPattern: slot.repeatPattern,
    }));

    if (slot.repeatPattern) {
      keys.add(buildLegacyRepeatableKey({
        jobId,
        repeatEvery: slot.repeatEvery,
        repeatPattern: slot.repeatPattern,
        repeatTimezone: slot.repeatTimezone || '',
      }));
    }
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

  for (const slot of schedulePlan.slots) {
    await addScheduledSapSyncJob({
      tenantKey,
      configId,
      objectType,
      mode: schedulePlan.mode,
      intervalMinutes: schedulePlan.intervalMinutes,
      executionTime: slot.executionTime,
      executionDays: schedulePlan.executionDays,
      startTime: schedulePlan.startTime,
      endTime: schedulePlan.endTime,
      slotIndex: slot.slotIndex,
      repeatEvery: slot.repeatEvery,
      repeatPattern: slot.repeatPattern,
      repeatTimezone: slot.repeatTimezone,
    });
  }

  return {
    jobId: buildScheduledJobId({ tenantKey, configId }),
    configId,
    objectType,
    schedulePlan,
  };
}

// Exige que estén TODOS los slots del plan, no cualquiera: la lista de candidatos de borrado incluye
// los 24 nombres posibles, así que un `.some()` sobre ella daría verdadero con que existiera uno
// solo y dejaría la config a medio programar.
function hasScheduledJob({ scheduledJobs, tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  if (!tenantKey || !configId || !Array.isArray(scheduledJobs)) {
    return false;
  }

  const schedulePlan = resolveSchedulePlan(config);
  if (!schedulePlan) {
    return false;
  }

  const jobId = buildScheduledJobId({ tenantKey, configId });

  return schedulePlan.slots.every((slot) => {
    const keys = new Set([
      buildScheduledJobId({ tenantKey, configId, slotIndex: slot.slotIndex }),
      buildLegacyRepeatableKey({
        jobId,
        repeatEvery: slot.repeatEvery,
        repeatPattern: slot.repeatPattern,
      }),
    ]);

    if (slot.repeatPattern) {
      keys.add(buildLegacyRepeatableKey({
        jobId,
        repeatEvery: slot.repeatEvery,
        repeatPattern: slot.repeatPattern,
        repeatTimezone: slot.repeatTimezone || '',
      }));
    }

    return scheduledJobs.some((job) => matchesScheduledJobKeys(job, keys));
  });
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
    executionTimes: schedulePlan.executionTimes,
    executionDays: schedulePlan.executionDays,
    startTime: schedulePlan.startTime,
    endTime: schedulePlan.endTime,
    slots: schedulePlan.slots.map((slot) => ({
      slotIndex: slot.slotIndex,
      executionTime: slot.executionTime,
      repeatEvery: slot.repeatEvery,
      repeatPattern: slot.repeatPattern,
      repeatTimezone: slot.repeatTimezone,
    })),
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
        const schedulePlan = resolveSchedulePlan(config);

        if (config.active && schedulePlan) {
          const slotKeys = schedulePlan.slots.map((slot) => buildScheduledJobId({
            tenantKey,
            configId,
            slotIndex: slot.slotIndex,
          }));

          if (upsertExisting) {
            for (const slotKey of slotKeys) {
              expectedJobKeys.add(slotKey);
            }
            await registerScheduledJob({ tenantKey, config });
            summary.configsScheduled += 1;
            continue;
          }

          if (hasScheduledJob({ scheduledJobs: scheduledJobs.all, tenantKey, config })) {
            summary.configsSkippedExisting += 1;
            continue;
          }

          // registerScheduledJob y no createScheduledJob: borra antes de crear. Si no, una config
          // FULL registrada bajo el nombre plano de antes de multihora quedaría con el plano Y con
          // :0, y correría dos veces a esa hora.
          await registerScheduledJob({ tenantKey, config });
          for (const slotKey of slotKeys) {
            scheduledJobs.all.push({
              key: slotKey,
              id: slotKey,
              name: SAP_SYNC_JOB_NAME,
            });
          }
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
