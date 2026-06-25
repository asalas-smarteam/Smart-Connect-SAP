import { tenantResolver } from '../middlewares/tenantResolver.js';
import {
  buildCreateDealController,
  buildCreateQuotationController,
  buildUpdateQuotationController,
  buildConvertQuotationToOrderController,
} from '#composition/webhooks.composition.js';

export default async function routes(app) {
  app.post(
    '/webhooks/hubspot/createDeal',
    { preHandler: tenantResolver },
    buildCreateDealController()
  );

  app.post(
    '/webhooks/hubspot/createQuotation',
    { preHandler: tenantResolver },
    buildCreateQuotationController()
  );

  app.post(
    '/webhooks/hubspot/updateQuotation',
    { preHandler: tenantResolver },
    buildUpdateQuotationController()
  );

  app.post(
    '/webhooks/hubspot/convertQuotationToOrder',
    { preHandler: tenantResolver },
    buildConvertQuotationToOrderController()
  );
}
