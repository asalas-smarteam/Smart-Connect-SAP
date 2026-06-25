import { getTenantModels } from '../tenant/tenantDatabase.js';
import {
  queueCreateDealEvent,
  queueWebhookEvent,
} from '#infrastructure/webhook/webhookEvent.service.js';

export class MongooseQueuedWebhookEventRepository {
  constructor({
    tenantModelResolver = getTenantModels,
    queueWebhookEventFn = queueWebhookEvent,
    queueCreateDealEventFn = queueCreateDealEvent,
  } = {}) {
    this.tenantModelResolver = tenantModelResolver;
    this.queueWebhookEventFn = queueWebhookEventFn;
    this.queueCreateDealEventFn = queueCreateDealEventFn;
  }

  async queueWebhookEvent({ tenantKey, eventType, payload }) {
    const tenantModels = await this.tenantModelResolver(tenantKey);
    return this.queueWebhookEventFn({
      WebhookEvent: tenantModels.WebhookEvent,
      eventType,
      payload,
    });
  }

  async queueCreateDealEvent({ tenantKey, payload }) {
    const tenantModels = await this.tenantModelResolver(tenantKey);
    return this.queueCreateDealEventFn({
      WebhookEvent: tenantModels.WebhookEvent,
      payload,
    });
  }
}

export default MongooseQueuedWebhookEventRepository;
