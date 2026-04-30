import { Queue } from 'bullmq';
import { getSharedBullMQConnection } from '../lib/bullmqRedis.js';
import logger from '../core/logger.js';

export const WEBHOOK_QUEUE_NAME = 'webhook-events';
export const WEBHOOK_JOB_NAME = 'webhook-tenant-job';

const DEFAULT_ATTEMPTS = Number(process.env.WEBHOOK_JOB_ATTEMPTS || 1);
const DEFAULT_BACKOFF_MS = Number(process.env.WEBHOOK_JOB_BACKOFF_MS || 15000);
const DEFAULT_REMOVE_ON_COMPLETE = Number(process.env.WEBHOOK_REMOVE_ON_COMPLETE || 100);
const DEFAULT_REMOVE_ON_FAIL = Number(process.env.WEBHOOK_REMOVE_ON_FAIL || 500);
const REPLACEABLE_JOB_STATES = new Set(['completed', 'failed']);

let webhookQueue = null;

function encodeJobIdPart(value) {
  return encodeURIComponent(String(value));
}

export function buildWebhookTenantJobId(tenantId) {
  return `webhook-${encodeJobIdPart(tenantId)}`;
}

export async function removeReplaceableWebhookTenantJob(queue, jobId) {
  const existingJob = await queue.getJob(jobId);

  if (!existingJob) {
    return { removed: false, state: null };
  }

  const state = await existingJob.getState();

  if (!REPLACEABLE_JOB_STATES.has(state)) {
    return { removed: false, state };
  }

  try {
    await existingJob.remove();
    return { removed: true, state };
  } catch (error) {
    logger.warn({
      msg: 'Could not remove previous webhook tenant job before enqueue',
      jobId,
      state,
      error: error.message,
    });

    return { removed: false, state, error: error.message };
  }
}

export function getWebhookQueue() {
  if (webhookQueue) {
    return webhookQueue;
  }

  webhookQueue = new Queue(WEBHOOK_QUEUE_NAME, {
    connection: getSharedBullMQConnection(),
    defaultJobOptions: {
      attempts: DEFAULT_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: DEFAULT_BACKOFF_MS,
      },
      removeOnComplete: {
        count: DEFAULT_REMOVE_ON_COMPLETE,
      },
      removeOnFail: {
        count: DEFAULT_REMOVE_ON_FAIL,
      },
    },
  });

  return webhookQueue;
}

export async function addWebhookTenantJob({ tenantId, tenantKey, portalId, triggerType = 'scheduled' }) {
  if (!tenantId) {
    throw new Error('tenantId is required to enqueue webhook tenant job');
  }

  const queue = getWebhookQueue();
  const jobId = buildWebhookTenantJobId(tenantId);
  await removeReplaceableWebhookTenantJob(queue, jobId);

  return queue.add(
    WEBHOOK_JOB_NAME,
    {
      tenantId: String(tenantId),
      tenantKey: tenantKey ? String(tenantKey) : null,
      portalId: portalId ? String(portalId) : null,
      triggerType,
    },
    {
      jobId,
    }
  );
}

export async function closeWebhookQueue() {
  if (!webhookQueue) {
    return;
  }

  await webhookQueue.close();
  webhookQueue = null;
}
