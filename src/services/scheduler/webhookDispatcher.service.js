import logger from '../../core/logger.js';
import { addWebhookTenantJob } from '../../queues/webhook.queue.js';
import { listActiveTenants } from '../../utils/tenantSubscriptions.js';

export async function enqueueWebhookJobsForActiveTenants({ triggerType = 'scheduled' } = {}) {
  const activeTenants = await listActiveTenants();
  const summary = {
    tenants: activeTenants.length,
    enqueued: 0,
    failed: 0,
    errors: [],
  };

  for (const { client } of activeTenants) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await addWebhookTenantJob({
        tenantId: client._id,
        tenantKey: client.tenantKey,
        portalId: client?.hubspot?.portalId || null,
        triggerType,
      });
      summary.enqueued += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({
        tenantId: String(client?._id || ''),
        tenantKey: client?.tenantKey || null,
        error: error.message,
      });
      logger.error({
        msg: 'Failed enqueueing webhook tenant job',
        tenantId: String(client?._id || ''),
        tenantKey: client?.tenantKey || null,
        error: error.message,
      });
    }
  }

  logger.info({
    msg: 'Webhook tenant dispatcher run completed',
    triggerType,
    ...summary,
  });

  return summary;
}
