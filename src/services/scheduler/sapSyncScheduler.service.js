import logger from '../../core/logger.js';
import { getTenantModels } from '../../config/tenantDatabase.js';
import { listActiveTenants } from '../../utils/tenantSubscriptions.js';
import {
  addScheduledSapSyncJob,
  buildScheduledJobId,
  getSapSyncQueue,
} from '../../queues/sapSync.queue.js';

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
  };
}

function isRepeatableScheduledJob(repeatJob) {
  return typeof repeatJob?.id === 'string' && repeatJob.id.startsWith('sap-sync:');
}

async function removeScheduledRepeatablesByJobId(jobId) {
  const queue = getSapSyncQueue();
  const repeatableJobs = await queue.getRepeatableJobs();
  const candidates = repeatableJobs.filter((job) => job.id === jobId);

  await Promise.all(candidates.map((job) => queue.removeRepeatableByKey(job.key)));
  return candidates.length;
}

export async function registerScheduledJob({ tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  const schedulePlan = resolveSchedulePlan(config);
  const objectType = config?.objectType || null;

  if (!tenantKey || !configId || !schedulePlan) {
    throw new Error('tenantKey, configId and valid schedule config are required');
  }

  const jobId = buildScheduledJobId({ tenantKey, configId });
  await removeScheduledRepeatablesByJobId(jobId);
  await addScheduledSapSyncJob({
    tenantKey,
    configId,
    objectType,
    mode: schedulePlan.mode,
    intervalMinutes: schedulePlan.intervalMinutes,
    executionTime: schedulePlan.executionTime,
    repeatEvery: schedulePlan.repeatEvery,
    repeatPattern: schedulePlan.repeatPattern,
  });

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
    jobId,
  });
}

export async function removeScheduledJob({ tenantKey, configId }) {
  if (!tenantKey || !configId) {
    throw new Error('tenantKey and configId are required');
  }

  const jobId = buildScheduledJobId({ tenantKey, configId });
  const removedCount = await removeScheduledRepeatablesByJobId(jobId);

  logger.info({
    msg: 'Scheduled SAP sync job removed',
    tenantKey,
    configId: String(configId),
    jobId,
    removedCount,
  });
}

export async function syncScheduledJob({ tenantKey, config }) {
  const configId = String(config?._id || config?.id || '');
  const schedulePlan = resolveSchedulePlan(config);
  const shouldSchedule = Boolean(config?.active) && Boolean(schedulePlan);

  if (!tenantKey || !configId) {
    throw new Error('tenantKey and config are required');
  }

  if (shouldSchedule) {
    await registerScheduledJob({ tenantKey, config });
    return { action: 'registered' };
  }

  await removeScheduledJob({ tenantKey, configId });
  return { action: 'removed' };
}

export async function bootstrapScheduledJobs() {
  const queue = getSapSyncQueue();
  const expectedJobIds = new Set();
  const activeTenants = await listActiveTenants();
  const summary = {
    tenantsScanned: 0,
    configsScheduled: 0,
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
        const jobId = buildScheduledJobId({ tenantKey, configId });
        const schedulePlan = resolveSchedulePlan(config);

        if (config.active && schedulePlan) {
          expectedJobIds.add(jobId);
          await registerScheduledJob({ tenantKey, config });
          summary.configsScheduled += 1;
        } else {
          await removeScheduledJob({ tenantKey, configId });
          summary.configsRemoved += 1;
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

  try {
    const repeatableJobs = await queue.getRepeatableJobs();
    const orphanedJobs = repeatableJobs.filter(
      (job) => isRepeatableScheduledJob(job) && !expectedJobIds.has(job.id)
    );

    for (const job of orphanedJobs) {
      await queue.removeRepeatableByKey(job.key);
      summary.orphanRemoved += 1;
      logger.info({
        msg: 'Removed orphan SAP sync repeatable job',
        repeatJobKey: job.key,
        jobId: job.id,
      });
    }
  } catch (error) {
    logger.error({
      msg: 'Failed while removing orphan SAP sync repeatable jobs',
      error: error.message,
    });
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
  const tenantJobs = repeatableJobs.filter((job) => job?.id?.startsWith(tenantPrefix));

  await Promise.all(tenantJobs.map((job) => queue.removeRepeatableByKey(job.key)));
  return tenantJobs.length;
}
