import cron from 'node-cron';
import { enqueueWebhookJobsForActiveTenants } from '../services/scheduler/webhookDispatcher.service.js';
import { processWebhookForActiveTenants } from '../services/webhookProcessorRunner.service.js';

export async function runWebhookProcessorOnce() {
  return enqueueWebhookJobsForActiveTenants({ triggerType: 'scheduled' });
}

export async function runWebhookProcessorManualOnce() {
  return processWebhookForActiveTenants({ triggerType: 'manual' });
}

export default function startWebhookProcessor() {
  const webhookJob = cron.schedule('*/1 * * * *', runWebhookProcessorOnce, { scheduled: false });
  return webhookJob;
}
