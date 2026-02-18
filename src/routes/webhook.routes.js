import { receiveHubspotWebhook } from '../controllers/webhook.controller.js';

export default async function routes(app) {
  app.post('/webhooks/hubspot', receiveHubspotWebhook);
}
