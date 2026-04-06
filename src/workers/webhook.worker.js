import { Worker } from 'bullmq';
import logger from '../core/logger.js';
import { createBullMQConnection } from '../lib/bullmqRedis.js';
import { WEBHOOK_JOB_NAME, WEBHOOK_QUEUE_NAME } from '../queues/webhook.queue.js';
import { processWebhookTenant } from '../services/webhookProcessorRunner.service.js';

const DEFAULT_WORKER_CONCURRENCY = Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 5);

async function processWebhookJob(job) {
  if (job.name !== WEBHOOK_JOB_NAME) {
    logger.warn({
      msg: 'Unknown webhook job name ignored',
      jobName: job.name,
      jobId: job.id,
    });
    return { ignored: true };
  }

  const { tenantId, tenantKey, portalId, triggerType } = job.data || {};

  if (!tenantId) {
    throw new Error('tenantId is required in webhook job payload');
  }

  return processWebhookTenant({
    tenantId,
    tenantKey,
    portalId,
    triggerType: triggerType || 'worker',
  });
}

export function startWebhookWorker() {
  const worker = new Worker(WEBHOOK_QUEUE_NAME, processWebhookJob, {
    connection: createBullMQConnection('webhook-worker'),
    concurrency: DEFAULT_WORKER_CONCURRENCY,
  });

  worker.on('ready', () => {
    logger.info({
      msg: 'Webhook BullMQ worker started',
      queue: WEBHOOK_QUEUE_NAME,
      concurrency: DEFAULT_WORKER_CONCURRENCY,
    });
  });

  worker.on('active', (job) => {
    logger.info({
      msg: 'Webhook worker job started',
      jobId: job.id,
      tenantId: job?.data?.tenantId,
      tenantKey: job?.data?.tenantKey || null,
      portalId: job?.data?.portalId || null,
      triggerType: job?.data?.triggerType || null,
    });
  });

  worker.on('completed', (job, result) => {
    logger.info({
      msg: 'Webhook worker job completed',
      jobId: job.id,
      tenantId: job?.data?.tenantId,
      tenantKey: job?.data?.tenantKey || null,
      portalId: job?.data?.portalId || null,
      triggerType: job?.data?.triggerType || null,
      result,
    });
  });

  worker.on('failed', (job, error) => {
    logger.error({
      msg: 'Webhook worker job failed',
      jobId: job?.id,
      tenantId: job?.data?.tenantId || null,
      tenantKey: job?.data?.tenantKey || null,
      portalId: job?.data?.portalId || null,
      triggerType: job?.data?.triggerType || null,
      error: error?.message,
    });
  });

  worker.on('error', (error) => {
    logger.error({
      msg: 'Webhook worker runtime error',
      error: error.message,
    });
  });

  return worker;
}
