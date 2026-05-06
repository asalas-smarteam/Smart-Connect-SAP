import { getTenantModels } from '../../../config/tenantDatabase.js';
import { queueCreateDealEvent } from '../../../services/webhookEvent.service.js';

export class MongooseQueuedWebhookEventRepository {
  constructor({
    tenantModelResolver = getTenantModels,
    queueCreateDealEventFn = queueCreateDealEvent,
  } = {}) {
    this.tenantModelResolver = tenantModelResolver;
    this.queueCreateDealEventFn = queueCreateDealEventFn;
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
