import { refreshAccessToken, testCreateContact } from '../controllers/hubspotHS.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.post('/test/access-token/:clientConfigId', { preHandler: tenantResolver }, refreshAccessToken);
  app.post('/hubspot/test-create-contact/:id', { preHandler: tenantResolver }, testCreateContact);
}
