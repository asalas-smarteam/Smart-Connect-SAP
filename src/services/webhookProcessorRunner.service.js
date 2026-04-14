import logger from '../core/logger.js';
import { getTenantModels } from '../config/tenantDatabase.js';
import webhookProcessor from './webhookProcessor.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
  finishSyncLog,
  startSyncLog,
} from './syncLog.service.js';
import { listActiveTenants, resolveActiveTenant } from '../utils/tenantSubscriptions.js';

async function resolveTenantContext({ tenantId, tenantKey, portalId }) {
  if (tenantKey) {
    return {
      tenantId: tenantId ? String(tenantId) : null,
      tenantKey: String(tenantKey),
      portalId: portalId ? String(portalId) : null,
    };
  }

  const activeTenant = await resolveActiveTenant({
    tenantId: tenantId ? String(tenantId) : undefined,
    portalId: portalId ? String(portalId) : undefined,
  });

  if (!activeTenant?.client?.tenantKey) {
    throw new Error('Tenant not found or inactive for webhook processing');
  }

  return {
    tenantId: String(activeTenant.client._id),
    tenantKey: activeTenant.client.tenantKey,
    portalId: activeTenant.client?.hubspot?.portalId || portalId || null,
  };
}

export async function processWebhookTenant({ tenantId, tenantKey, portalId, triggerType = 'worker' }) {
  const context = await resolveTenantContext({ tenantId, tenantKey, portalId });
  const tenantModels = await getTenantModels(context.tenantKey);
  const syncLog = await startSyncLog({ tenantModels });

  logger.info({
    msg: 'Starting webhook tenant processing',
    triggerType,
    tenantId: context.tenantId,
    tenantKey: context.tenantKey,
    portalId: context.portalId || null,
  });

  try {
    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: context.tenantId,
      tenantKey: context.tenantKey,
      portalId: context.portalId,
    });

    await finishSyncLog(syncLog, {
      status: result.errored > 0 ? 'errored' : 'completed',
      recordsProcessed: result.processed || 0,
      sent: result.completed || 0,
      failed: result.errored || 0,
      errorMessage: Array.isArray(result.errorDetails) && result.errorDetails.length > 0
        ? result.errorDetails
        : null,
    });

    logger.info({
      msg: 'Webhook tenant processing finished',
      triggerType,
      tenantId: context.tenantId,
      tenantKey: context.tenantKey,
      portalId: context.portalId || null,
      ...result,
    });

    return {
      ...result,
      tenantId: context.tenantId,
      tenantKey: context.tenantKey,
      portalId: context.portalId || null,
    };
  } catch (error) {
    await finishSyncLog(syncLog, {
      status: 'errored',
      recordsProcessed: 0,
      sent: 0,
      failed: 1,
      errorMessage: error.syncLogWebhookErrors || [
        buildWebhookSyncErrorEntry({
          payloadHubspot: {
            tenantId: context.tenantId,
            tenantKey: context.tenantKey,
            portalId: context.portalId || null,
            triggerType,
          },
          payloadSap: null,
          responseHubspot: null,
          responseSap: buildErrorResponseSnapshot(error),
        }),
      ],
    });
    throw error;
  }
}

export async function processWebhookForActiveTenants({ triggerType = 'manual' } = {}) {
  const activeTenants = await listActiveTenants();
  const summary = {
    tenants: activeTenants.length,
    processed: 0,
    completed: 0,
    retried: 0,
    errored: 0,
    skipped: 0,
    tenantErrors: [],
  };

  for (const { client } of activeTenants) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await processWebhookTenant({
        tenantId: client._id,
        tenantKey: client.tenantKey,
        portalId: client?.hubspot?.portalId || null,
        triggerType,
      });

      summary.processed += result.processed || 0;
      summary.completed += result.completed || 0;
      summary.retried += result.retried || 0;
      summary.errored += result.errored || 0;
      summary.skipped += result.skipped || 0;
    } catch (error) {
      summary.tenantErrors.push({
        tenantId: String(client._id),
        tenantKey: client.tenantKey,
        error: error.message,
      });

      logger.error({
        msg: 'Webhook tenant processing failed',
        triggerType,
        tenantId: String(client._id),
        tenantKey: client.tenantKey,
        error: error.message,
      });
    }
  }

  return summary;
}
