import { tenantResolver } from '../middlewares/tenantResolver.js';
import buildWebhookController from '#composition/webhooks.composition.js';

export default async function routes(app) {
  app.post(
    '/webhooks/hubspot/createDeal', 
    {preHandler: tenantResolver}, 
    buildWebhookController()
  );
}
