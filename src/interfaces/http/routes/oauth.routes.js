import { initOAuthForTenant, oauthCallback } from '../controllers/oauth.controller.js';
import { internalKeyAuthOnly } from '../middlewares/internalAuth.js';

export default async function routes(app) {
  // Público por necesidad: HubSpot redirige el navegador acá y no puede mandar headers propios.
  // Lo protege el state firmado que emite el init (ver oauth-state.service.js).
  app.get('/oauth/hubspot/callback', oauthCallback);

  // Genera el link de instalación y registra el portal del tenant: solo para el equipo.
  app.post('/oauth/hubspot/init', { preHandler: internalKeyAuthOnly }, initOAuthForTenant);
}
