import { Worker } from 'bullmq';
import logger from '../../../infrastructure/logger/logger.adapter.js';
import { createBullMQConnection } from '../../../infrastructure/queue/bullmqRedis.js';
import {
  WEBHOOK_QUEUE_NAME,
} from '../../../infrastructure/queue/webhook.queue.adapter.js';
import { processWebhookJob } from '../webhook.job.js';

const DEFAULT_WORKER_CONCURRENCY = Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 5);

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

