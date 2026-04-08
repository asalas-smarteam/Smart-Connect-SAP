import lineItemPriceController from '../controllers/lineItemPrice.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.post(
    '/webhooks/hubspot/line-items/prices',
    { preHandler: tenantResolver },
    lineItemPriceController.syncPrices
  );
}
