import {
  buildSapSyncTenantRepository,
  buildSyncSapConfigToHubspot,
  buildTenantSapSyncLockAdapter,
} from '#composition/sap-sync.composition.js';
import logger from '#infrastructure/logger/logger.adapter.js';
import { SAP_SYNC_JOB_NAME } from '#infrastructure/queue/sap-sync.queue.adapter.js';

export const LOCK_RETRY_ERROR_CODE = 'TENANT_SAP_SYNC_LOCKED';
const SAP_SYNC_TIMEZONE = 'America/Costa_Rica';

export class TenantLockedError extends Error {
  constructor(tenantKey) {
    super(`SAP sync lock already acquired for tenant ${tenantKey}`);
    this.name = 'TenantLockedError';
    this.code = LOCK_RETRY_ERROR_CODE;
  }
}

export async function safeUpdateJobData(job, nextData) {
  try {
    await job.updateData(nextData);
  } catch (error) {
    logger.warn({
      msg: 'Failed updating SAP sync job data metadata',
      jobId: job?.id,
      error: error.message,
    });
  }
}

export async function safeAddJobLog(job, message, metadata = {}) {
  if (typeof job?.log !== 'function') {
    return;
  }

  try {
    await job.log(JSON.stringify({
      msg: message,
      ...metadata,
    }));
  } catch (error) {
    logger.warn({
      msg: 'Failed adding SAP sync BullMQ job log',
      jobId: job?.id,
      error: error.message,
    });
  }
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

function getZonedMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: SAP_SYNC_TIMEZONE,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function isMinuteInsideWindow({ current, start, end }) {
  if (start <= end) {
    return current >= start && current <= end;
  }

  return current >= start || current <= end;
}

function minutesSinceWindowStart({ current, start }) {
  if (current >= start) {
    return current - start;
  }

  return current + 1440 - start;
}

export function shouldRunIncrementalScheduleNow(config, date) {
  const mode = String(config?.mode || '').trim().toUpperCase();
  if (mode !== 'INCREMENTAL' || !config?.startTime || !config?.endTime) {
    return true;
  }

  const intervalMinutes = Number(config?.intervalMinutes);
  const start = parseTime(config.startTime);
  const end = parseTime(config.endTime);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0 || start === null || end === null) {
    return false;
  }

  const current = getZonedMinutes(date);
  if (!isMinuteInsideWindow({ current, start, end })) {
    return false;
  }

  return minutesSinceWindowStart({ current, start }) % intervalMinutes === 0;
}

function normalizeSyncMetrics(result) {
  return {
    recordsProcessed: Number(result?.metrics?.recordsProcessed ?? 0),
    hubspotSent: Number(result?.metrics?.hubspotSent ?? 0),
    hubspotFailed: Number(result?.metrics?.hubspotFailed ?? 0),
    hubspotCreated: Number(result?.metrics?.hubspotCreated ?? 0),
    hubspotUpdated: Number(result?.metrics?.hubspotUpdated ?? 0),
  };
}

export function createSapSyncJobProcessor({
  tenantRepository = buildSapSyncTenantRepository(),
  lockAdapter = buildTenantSapSyncLockAdapter(),
  syncUseCase = buildSyncSapConfigToHubspot(),
  dateProvider = () => new Date(),
} = {}) {
  return async function processSapSyncJob(job) {
    if (job.name !== SAP_SYNC_JOB_NAME) {
      logger.warn({
        msg: 'Unknown SAP sync job name ignored',
        jobName: job.name,
        jobId: job.id,
      });
      return { ignored: true };
    }

    const { tenantKey, configId, triggerType } = job.data || {};
    const startedAt = dateProvider();

    if (!tenantKey || !configId) {
      throw new Error('tenantKey and configId are required in job payload');
    }

    let lock = null;
    let lockRenewTimer = null;
    try {
      await safeUpdateJobData(job, {
        ...(job.data || {}),
        startedAt: startedAt.toISOString(),
        status: 'running',
      });
      await safeAddJobLog(job, 'SAP sync job started', {
        tenantKey,
        configId,
        triggerType,
        startedAt: startedAt.toISOString(),
      });

      const { tenantModels, config } = await tenantRepository.loadConfig({ tenantKey, configId });

      if (!config) {
        throw new Error(`ClientConfig ${configId} not found for tenant ${tenantKey}`);
      }

      if (triggerType === 'scheduled' && !config.active) {
        logger.info({
          msg: 'Skipping scheduled SAP sync because config is inactive',
          tenantKey,
          configId,
          jobId: job.id,
        });
        await safeAddJobLog(job, 'SAP sync job skipped because config is inactive', {
          tenantKey,
          configId,
          triggerType,
        });
        return { skipped: true, reason: 'inactive-config' };
      }

      if (triggerType === 'scheduled' && !shouldRunIncrementalScheduleNow(config, startedAt)) {
        logger.info({
          msg: 'Skipping scheduled SAP sync because execution time is outside incremental window',
          tenantKey,
          configId,
          jobId: job.id,
          startTime: config.startTime || null,
          endTime: config.endTime || null,
          intervalMinutes: config.intervalMinutes || null,
        });
        await safeAddJobLog(job, 'SAP sync job skipped outside incremental window', {
          tenantKey,
          configId,
          triggerType,
          startTime: config.startTime || null,
          endTime: config.endTime || null,
          intervalMinutes: config.intervalMinutes || null,
        });
        return { skipped: true, reason: 'outside-incremental-window' };
      }

      lock = await lockAdapter.acquire(tenantKey);
      if (!lock) {
        throw new TenantLockedError(tenantKey);
      }

      const renewEveryMs = Math.max(Math.floor(lock.ttlMs / 3), 10000);
      lockRenewTimer = setInterval(async () => {
        try {
          const renewed = await lockAdapter.extend(lock, lock.ttlMs);
          if (!renewed) {
            logger.warn({
              msg: 'SAP sync tenant lock renewal failed',
              tenantKey,
              configId,
              jobId: job.id,
            });
          }
        } catch (error) {
          logger.warn({
            msg: 'SAP sync tenant lock renewal error',
            tenantKey,
            configId,
            jobId: job.id,
            error: error.message,
          });
        }
      }, renewEveryMs);

      logger.info({
        msg: 'SAP sync tenant lock acquired',
        tenantKey,
        configId,
        triggerType,
        jobId: job.id,
      });
      await safeAddJobLog(job, 'SAP sync tenant lock acquired', {
        tenantKey,
        configId,
        triggerType,
      });

      const syncResult = await syncUseCase.execute({
        config,
        tenantContext: { tenantKey, tenantModels },
      });
      const metrics = normalizeSyncMetrics(syncResult);

      const finishedAt = dateProvider();
      const duration = finishedAt.getTime() - startedAt.getTime();
      await safeUpdateJobData(job, {
        ...(job.data || {}),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'success',
        ...metrics,
      });
      await safeAddJobLog(job, 'SAP sync job completed', {
        tenantKey,
        configId,
        triggerType,
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'success',
        ...metrics,
      });

      logger.info({
        msg: 'SAP sync worker execution completed',
        tenantKey,
        configId,
        triggerType,
        jobId: job.id,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'success',
        ...metrics,
      });

      return {
        ok: true,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'success',
        metrics,
      };
    } catch (error) {
      const finishedAt = dateProvider();
      const duration = finishedAt.getTime() - startedAt.getTime();
      await safeUpdateJobData(job, {
        ...(job.data || {}),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'error',
      });
      await safeAddJobLog(job, 'SAP sync job failed', {
        tenantKey,
        configId,
        triggerType,
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'error',
        error: error.message,
      });
      throw error;
    } finally {
      if (lockRenewTimer) {
        clearInterval(lockRenewTimer);
        lockRenewTimer = null;
      }

      if (lock) {
        const released = await lockAdapter.release(lock);
        logger.info({
          msg: 'SAP sync tenant lock released',
          tenantKey,
          configId,
          lockReleased: released,
          jobId: job.id,
        });
        await safeAddJobLog(job, 'SAP sync tenant lock released', {
          tenantKey,
          configId,
          lockReleased: released,
        });
      }
    }
  };
}

export const processSapSyncJob = createSapSyncJobProcessor();

export default processSapSyncJob;
