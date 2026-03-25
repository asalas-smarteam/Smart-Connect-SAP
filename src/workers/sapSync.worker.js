import { Worker } from 'bullmq';
import logger from '../core/logger.js';
import { getTenantModels } from '../config/tenantDatabase.js';
import syncService from '../services/syncService.js';
import { createBullMQConnection } from '../lib/bullmqRedis.js';
import { SAP_SYNC_JOB_NAME, SAP_SYNC_QUEUE_NAME } from '../queues/sapSync.queue.js';
import {
  acquireTenantSapSyncLock,
  extendTenantSapSyncLock,
  releaseTenantSapSyncLock,
} from '../services/locks/tenantSapSyncLock.service.js';

const DEFAULT_WORKER_CONCURRENCY = Number(process.env.SAP_SYNC_WORKER_CONCURRENCY || 5);
const LOCK_RETRY_ERROR_CODE = 'TENANT_SAP_SYNC_LOCKED';

class TenantLockedError extends Error {
  constructor(tenantKey) {
    super(`SAP sync lock already acquired for tenant ${tenantKey}`);
    this.name = 'TenantLockedError';
    this.code = LOCK_RETRY_ERROR_CODE;
  }
}

async function loadConfigFromTenant(tenantKey, configId) {
  const tenantModels = await getTenantModels(tenantKey);
  const { ClientConfig } = tenantModels;
  const config = await ClientConfig.findById(configId);

  return {
    tenantModels,
    config,
  };
}

async function processSapSyncJob(job) {
  if (job.name !== SAP_SYNC_JOB_NAME) {
    logger.warn({
      msg: 'Unknown SAP sync job name ignored',
      jobName: job.name,
      jobId: job.id,
    });
    return { ignored: true };
  }

  const { tenantKey, configId, triggerType } = job.data || {};

  if (!tenantKey || !configId) {
    throw new Error('tenantKey and configId are required in job payload');
  }

  let lock = null;
  let lockRenewTimer = null;
  try {
    const { tenantModels, config } = await loadConfigFromTenant(tenantKey, configId);

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
      return { skipped: true, reason: 'inactive-config' };
    }

    lock = await acquireTenantSapSyncLock(tenantKey);
    if (!lock) {
      throw new TenantLockedError(tenantKey);
    }

    const renewEveryMs = Math.max(Math.floor(lock.ttlMs / 3), 10000);
    lockRenewTimer = setInterval(async () => {
      try {
        const renewed = await extendTenantSapSyncLock(lock, lock.ttlMs);
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

    await syncService.run(config, tenantModels);

    logger.info({
      msg: 'SAP sync worker execution completed',
      tenantKey,
      configId,
      triggerType,
      jobId: job.id,
    });

    return { ok: true };
  } finally {
    if (lockRenewTimer) {
      clearInterval(lockRenewTimer);
      lockRenewTimer = null;
    }

    if (lock) {
      const released = await releaseTenantSapSyncLock(lock);
      logger.info({
        msg: 'SAP sync tenant lock released',
        tenantKey,
        configId,
        lockReleased: released,
        jobId: job.id,
      });
    }
  }
}

export function startSapSyncWorker() {
  const worker = new Worker(SAP_SYNC_QUEUE_NAME, processSapSyncJob, {
    connection: createBullMQConnection('worker'),
    concurrency: DEFAULT_WORKER_CONCURRENCY,
  });

  worker.on('ready', () => {
    logger.info({
      msg: 'SAP sync BullMQ worker started',
      queue: SAP_SYNC_QUEUE_NAME,
      concurrency: DEFAULT_WORKER_CONCURRENCY,
    });
  });

  worker.on('active', (job) => {
    logger.info({
      msg: 'SAP sync worker job started',
      jobId: job.id,
      tenantKey: job?.data?.tenantKey,
      configId: job?.data?.configId,
      triggerType: job?.data?.triggerType,
    });
  });

  worker.on('completed', (job) => {
    logger.info({
      msg: 'SAP sync worker job completed',
      jobId: job.id,
      tenantKey: job?.data?.tenantKey,
      configId: job?.data?.configId,
      triggerType: job?.data?.triggerType,
    });
  });

  worker.on('failed', (job, error) => {
    logger.error({
      msg: 'SAP sync worker job failed',
      jobId: job?.id,
      tenantKey: job?.data?.tenantKey,
      configId: job?.data?.configId,
      triggerType: job?.data?.triggerType,
      error: error?.message,
      retryHint: error?.code === LOCK_RETRY_ERROR_CODE ? 'tenant-lock-retry' : 'job-failed',
    });
  });

  worker.on('error', (error) => {
    logger.error({
      msg: 'SAP sync worker runtime error',
      error: error.message,
    });
  });

  return worker;
}
