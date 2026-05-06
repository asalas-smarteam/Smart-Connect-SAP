import logger from '../../infrastructure/logger/logger.adapter.js';
import { SAP_SYNC_JOB_NAME } from '../../infrastructure/queue/sap-sync.queue.adapter.js';
import MongooseSapSyncTenantRepository from '../../infrastructure/database/repositories/MongooseSapSyncTenantRepository.js';
import MongooseSyncLogRepository from '../../infrastructure/database/repositories/MongooseSyncLogRepository.js';
import MappingSyncRepository from '../../infrastructure/repositories/MappingSyncRepository.js';
import HubspotSyncAdapter from '../../infrastructure/hubspot/HubspotSyncAdapter.js';
import SapSyncDataAdapter from '../../infrastructure/sap/SapSyncDataAdapter.js';
import TenantSapSyncLockAdapter from '../../infrastructure/locks/TenantSapSyncLockAdapter.js';
import SyncSapConfigToHubspot from '../../application/use-cases/SyncSapConfigToHubspot.js';

export const LOCK_RETRY_ERROR_CODE = 'TENANT_SAP_SYNC_LOCKED';

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

function createDefaultSyncUseCase() {
  return new SyncSapConfigToHubspot({
    sapDataSource: new SapSyncDataAdapter(),
    mappingRepository: new MappingSyncRepository(),
    hubspotSyncTarget: new HubspotSyncAdapter(),
    syncLogRepository: new MongooseSyncLogRepository(),
  });
}

export function createSapSyncJobProcessor({
  tenantRepository = new MongooseSapSyncTenantRepository(),
  lockAdapter = new TenantSapSyncLockAdapter(),
  syncUseCase = createDefaultSyncUseCase(),
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
        return { skipped: true, reason: 'inactive-config' };
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

      await syncUseCase.execute({ config, tenantModels });

      const finishedAt = dateProvider();
      const duration = finishedAt.getTime() - startedAt.getTime();
      await safeUpdateJobData(job, {
        ...(job.data || {}),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'success',
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
      });

      return {
        ok: true,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        duration,
        status: 'success',
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
      }
    }
  };
}

export const processSapSyncJob = createSapSyncJobProcessor();

export default processSapSyncJob;

