import cron from 'node-cron';
import { getTenantModels } from '../config/tenantDatabase.js';
import webhookProcessor from '../services/webhookProcessor.js';
import { listActiveTenants } from '../utils/tenantSubscriptions.js';

export async function runWebhookProcessorOnce() {
  const activeTenants = await listActiveTenants();

  for (const { client } of activeTenants) {
    const tenantModels = await getTenantModels(client.tenantKey);
    await webhookProcessor.processPendingEvents({ tenantModels });
  }
}

export default function startWebhookProcessor() {
  const webhookJob = cron.schedule('*/1 * * * *', runWebhookProcessorOnce, { scheduled: false });
  return webhookJob;
}

/*
function test() {
  console.log("Running webhook processor test...");
}*/