import { initOAuth, oauthCallback } from '../controllers/oauth.controller.js';

export default async function routes(app) {
  app.get('/oauth/hubspot/init/:clientConfigId', initOAuth);
  app.get('/oauth/hubspot/callback', oauthCallback);
}
