import { receiveHubspotWebhook } from '../controllers/webhook.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';


export default async function routes(app) {
  app.post(
    '/webhooks/hubspot/createDeal', 
    {preHandler: tenantResolver}, 
    receiveHubspotWebhook
  );
}