import logger from '../../core/logger.js';
import crypto from 'crypto';
import { getTenantModels } from '../../config/tenantDatabase.js';
import { listActiveTenants } from '../../utils/tenantSubscriptions.js';
import {
  addScheduledSapSyncJob,
  buildScheduledJobId,
  SAP_SYNC_JOB_NAME,
  getSapSyncQueue,
} from '../../queues/sapSync.queue.js';

const SAP_SYNC_SCHEDULER_TIMEZONE = 'America/Costa_Rica';

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

function buildDailyPattern(executionTime) {
  const value = String(executionTime || '').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 5 || minutes < 0 || minutes > 59) {
    return null;
  }

  if (hours === 5 && minutes > 0) {
    return null;
  }

  return `${minutes} ${hours} * * *`;
}

function resolveSchedulePlan(config) {
  const mode = normalizeMode(config?.mode);
  const intervalMinutes = normalizeIntervalMinutes(config?.intervalMinutes);
  const executionTime = String(config?.executionTime || '').trim() || null;
  const cronPattern = buildDailyPattern(executionTime);

  if (mode === 'FULL') {
    if (!cronPattern) {
      return null;
    }
    return {
      mode,
      intervalMinutes: null,
      executionTime,
      repeatEvery: null,
      repeatPattern: cronPattern,
      repeatTimezone: SAP_SYNC_SCHEDULER_TIMEZONE,
    };
  }

  if (!intervalMinutes) {
    return null;
  }

  return {
    mode,
    intervalMinutes,
    executionTime: null,
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
  const repeatableJobs = await queue.getRepeatableJobs();
  const knownKeys = new Set(keys.filter(Boolean));
  const candidates = repeatableJobs.filter(
    (job) => knownKeys.has(job.key) || (job.id && knownKeys.has(job.id))
  );

  await Promise.all(candidates.map((job) => queue.removeRepeatableByKey(job.key)));
  return candidates.length;
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

function hasScheduledJob({ repeatableJobs, tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  if (!tenantKey || !configId || !Array.isArray(repeatableJobs)) {
    return false;
  }

  const jobId = buildScheduledJobId({ tenantKey, configId });
  const candidateKeys = new Set(buildRemovalKeyCandidates({ jobId, config }));

  return repeatableJobs.some(
    (job) => candidateKeys.has(job?.key) || (typeof job?.id === 'string' && candidateKeys.has(job.id))
  );
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
  const repeatableJobs = await queue.getRepeatableJobs();
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

          if (hasScheduledJob({ repeatableJobs, tenantKey, config })) {
            summary.configsSkippedExisting += 1;
            continue;
          }

          await createScheduledJob({ tenantKey, config });
          repeatableJobs.push({
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

  if (upsertExisting) {
    try {
      const latestRepeatableJobs = await queue.getRepeatableJobs();
      const orphanedJobs = latestRepeatableJobs.filter(
        (job) => isRepeatableScheduledJob(job) && !expectedJobKeys.has(job.key)
      );

      for (const job of orphanedJobs) {
        await queue.removeRepeatableByKey(job.key);
        summary.orphanRemoved += 1;
        logger.info({
          msg: 'Removed orphan SAP sync repeatable job',
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
  const repeatableJobs = await queue.getRepeatableJobs();
  const tenantPrefix = `sap-sync:${tenantKey}:`;
  const tenantJobs = repeatableJobs.filter((job) => job?.key?.startsWith(tenantPrefix));

  await Promise.all(tenantJobs.map((job) => queue.removeRepeatableByKey(job.key)));
  return tenantJobs.length;
}
