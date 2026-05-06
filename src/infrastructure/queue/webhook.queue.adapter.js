import {
  WEBHOOK_JOB_NAME,
  WEBHOOK_QUEUE_NAME,
  addWebhookTenantJob,
  buildWebhookTenantJobId,
  closeWebhookQueue,
  getWebhookQueue,
  removeReplaceableWebhookTenantJob,
} from './webhook.queue.js';

export {
  WEBHOOK_JOB_NAME,
  WEBHOOK_QUEUE_NAME,
  addWebhookTenantJob,
  buildWebhookTenantJobId,
  closeWebhookQueue,
  getWebhookQueue,
  removeReplaceableWebhookTenantJob,
};

export const webhookQueueAdapter = Object.freeze({
  addManualJob: addWebhookTenantJob,
  addScheduledJob: addWebhookTenantJob,
  close: closeWebhookQueue,
  getQueue: getWebhookQueue,
});

export default webhookQueueAdapter;

