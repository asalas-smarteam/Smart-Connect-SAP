import { processWebhookTenant } from './webhookProcessorRunner.service.js';

export class WebhookTenantProcessorAdapter {
  async process(payload) {
    return processWebhookTenant(payload);
  }
}

export const webhookTenantProcessorAdapter = new WebhookTenantProcessorAdapter();

export default webhookTenantProcessorAdapter;
