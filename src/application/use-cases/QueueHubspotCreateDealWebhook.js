import QueueHubspotWebhookEvent from './QueueHubspotWebhookEvent.js';

// Backwards-compatible wrapper for the existing createDeal flow. Behaviour is unchanged;
// it simply pins the generic queue use case to eventType 'createDeal'.
export class QueueHubspotCreateDealWebhook extends QueueHubspotWebhookEvent {
  constructor(deps = {}) {
    super({ ...deps, eventType: deps.eventType || 'createDeal' });
  }
}

export default QueueHubspotCreateDealWebhook;
