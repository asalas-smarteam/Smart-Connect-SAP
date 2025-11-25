import { refreshAccessToken, testCreateContact } from '../controllers/hubspotHS.controller.js';

export default async function routes(app) {
  app.post('/test/access-token/:clientConfigId', refreshAccessToken);
  app.post('/hubspot/test-create-contact/:id', testCreateContact);
}
