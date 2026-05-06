import { Worker } from 'bullmq';
import logger from '../infrastructure/logger/logger.adapter.js';
import { createBullMQConnection } from '../lib/bullmqRedis.js';
import {
  SAP_SYNC_QUEUE_NAME,
} from '../infrastructure/queue/sap-sync.queue.adapter.js';
import {
  LOCK_RETRY_ERROR_CODE,
  processSapSyncJob,
} from '../interfaces/jobs/sap-sync.job.js';

const DEFAULT_WORKER_CONCURRENCY = Number(process.env.SAP_SYNC_WORKER_CONCURRENCY || 5);

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
      startedAt: job?.data?.startedAt || null,
      finishedAt: job?.data?.finishedAt || null,
      duration: job?.data?.duration || null,
      status: job?.data?.status || 'error',
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

