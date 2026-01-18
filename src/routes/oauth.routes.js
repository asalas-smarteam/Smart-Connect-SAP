import { initOAuth, oauthCallback } from '../controllers/oauth.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.get('/oauth/hubspot/init/:clientConfigId', { preHandler: tenantResolver }, initOAuth);
  app.get('/oauth/hubspot/callback', { preHandler: tenantResolver }, oauthCallback);
}
