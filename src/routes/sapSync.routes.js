import { triggerSapSync } from '../controllers/sapSync.controller.js';

export default async function routes(app) {
  app.post('/sap-sync/run', triggerSapSync);
}
