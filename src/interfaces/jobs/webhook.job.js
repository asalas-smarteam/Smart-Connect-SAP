import logger from '#infrastructure/logger/logger.adapter.js';
import {
  WEBHOOK_JOB_NAME,
} from '#infrastructure/queue/webhook.queue.adapter.js';
import webhookTenantProcessorAdapter from '#infrastructure/webhook/WebhookTenantProcessorAdapter.js';

export function createWebhookJobProcessor({
  webhookTenantProcessor = (payload) => webhookTenantProcessorAdapter.process(payload),
} = {}) {
  return async function processWebhookJob(job) {
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

    return webhookTenantProcessor({
      tenantId,
      tenantKey,
      portalId,
      triggerType: triggerType || 'worker',
    });
  };
}

export const processWebhookJob = createWebhookJobProcessor();

export default processWebhookJob;
