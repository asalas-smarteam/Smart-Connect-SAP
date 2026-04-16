import { getTenantModels } from '../../config/tenantDatabase.js';
import logger from '../../core/logger.js';
import { addManualSapSyncJob, getSapSyncQueue } from '../../queues/sapSync.queue.js';
import {
  bootstrapScheduledJobs,
  removeTenantScheduledJobs,
  syncScheduledJob,
} from './sapSyncScheduler.service.js';

function serializeConfig(config) {
  return {
    id: String(config._id),
    active: Boolean(config.active),
    objectType: config.objectType || null,
    mode: config.mode || 'INCREMENTAL',
    intervalMinutes: config.intervalMinutes || null,
    executionTime: config.executionTime || null,
  };
}

export async function getQueueDashboardSnapshot() {
  const queue = getSapSyncQueue();
  const [counts, repeatableJobs, activeJobs, waitingJobs, delayedJobs, failedJobs, completedJobs] =
    await Promise.all([
      queue.getJobCounts(
        'active',
        'waiting',
        'delayed',
        'failed',
        'completed',
        'paused',
        'prioritized'
      ),
      queue.getRepeatableJobs(),
      queue.getJobs(['active'], 0, 20, true),
      queue.getJobs(['waiting'], 0, 20, true),
      queue.getJobs(['delayed'], 0, 20, true),
      queue.getJobs(['failed'], 0, 20, true),
      queue.getJobs(['completed'], 0, 20, true),
    ]);

  const mapJob = (job) => ({
    id: job.id,
    name: job.name,
    timestamp: job.timestamp,
    attemptsMade: job.attemptsMade,
    data: job.data,
    failedReason: job.failedReason || null,
  });

  return {
    queueName: queue.name,
    counts,
    repeatableJobs: repeatableJobs.map((job) => ({
      key: job.key,
      id: job.id,
      name: job.name,
      every: job.every || null,
      pattern: job.pattern || null,
      next: job.next || null,
    })),
    jobs: {
      active: activeJobs.map(mapJob),
      waiting: waitingJobs.map(mapJob),
      delayed: delayedJobs.map(mapJob),
      failed: failedJobs.map(mapJob),
      completed: completedJobs.map(mapJob),
    },
  };
}

export async function setConfigActiveState({ tenantKey, configId, active }) {
  if (!tenantKey || !configId) {
    throw new Error('tenantKey and configId are required');
  }

  const tenantModels = await getTenantModels(tenantKey);
  const { ClientConfig } = tenantModels;
  const config = await ClientConfig.findById(configId);

  if (!config) {
    throw new Error(`ClientConfig ${configId} not found for tenant ${tenantKey}`);
  }

  config.active = Boolean(active);
  await config.save();
  await syncScheduledJob({ tenantKey, config });

  logger.info({
    msg: 'SAP sync config active state updated',
    tenantKey,
    configId: String(configId),
    active: config.active,
  });

  return serializeConfig(config);
}

export async function runConfigManualJob({ tenantKey, configId }) {
  if (!tenantKey || !configId) {
    throw new Error('tenantKey and configId are required');
  }

  const tenantModels = await getTenantModels(tenantKey);
  const { ClientConfig } = tenantModels;
  const config = await ClientConfig.findById(configId);

  if (!config) {
    throw new Error(`ClientConfig ${configId} not found for tenant ${tenantKey}`);
  }

  const job = await addManualSapSyncJob({
    tenantKey,
    configId: String(config._id),
    objectType: config.objectType || null,
    mode: config.mode || 'INCREMENTAL',
    intervalMinutes: config.intervalMinutes || null,
    executionTime: config.executionTime || null,
  });

  logger.info({
    msg: 'Manual SAP sync job queued',
    tenantKey,
    configId: String(config._id),
    jobId: job.id,
  });

  return {
    jobId: job.id,
    config: serializeConfig(config),
  };
}

export async function syncSingleConfigSchedule({ tenantKey, configId }) {
  if (!tenantKey || !configId) {
    throw new Error('tenantKey and configId are required');
  }

  const tenantModels = await getTenantModels(tenantKey);
  const { ClientConfig } = tenantModels;
  const config = await ClientConfig.findById(configId);

  if (!config) {
    throw new Error(`ClientConfig ${configId} not found for tenant ${tenantKey}`);
  }

  const result = await syncScheduledJob({ tenantKey, config });
  return {
    ...result,
    config: serializeConfig(config),
  };
}

export async function resyncSchedulerFromDatabase() {
  return bootstrapScheduledJobs({ upsertExisting: true });
}

export async function purgeTenantJobs(tenantKey) {
  const repeatableRemoved = await removeTenantScheduledJobs(tenantKey);
  const queue = getSapSyncQueue();
  const waitingJobs = await queue.getJobs(['waiting', 'delayed', 'failed', 'completed'], 0, -1, true);
  const toRemove = waitingJobs.filter((job) => job?.data?.tenantKey === tenantKey);
  await Promise.all(toRemove.map((job) => job.remove()));

  return {
    repeatableRemoved,
    jobsRemoved: toRemove.length,
  };
}
