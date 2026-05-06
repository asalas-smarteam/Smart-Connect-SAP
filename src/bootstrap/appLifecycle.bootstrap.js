import env from '#infrastructure/config/env.js';
import { initializeExternalConnections } from '#infrastructure/database/externalDb.js';
import { bootstrapSapSyncScheduler } from './sapSyncScheduler.bootstrap.js';
import startSapSync from '#interfaces/jobs/tasks/sapSyncTask.js';
import startWebhookProcessor from '#interfaces/jobs/tasks/webhookProcessorTask.js';

async function startCronJobIfEnabled({ enabled, createJob }) {
  if (!enabled) {
    return;
  }

  const job = await createJob();
  if (job?.start) {
    job.start();
  }
}

export function registerAppLifecycle(app) {
  app.addHook('onReady', async () => {
    await initializeExternalConnections();
    await bootstrapSapSyncScheduler();

    await startCronJobIfEnabled({
      enabled: env.SAP_SYNC_CRON_ENABLED !== 'false',
      createJob: startSapSync,
    });

    await startCronJobIfEnabled({
      enabled: env.WEBHOOK_PROCESSOR_CRON_ENABLED !== 'false',
      createJob: startWebhookProcessor,
    });
  });
}

export default registerAppLifecycle;
