import {
  createClientConfig,
  getClientConfig,
  createIntegrationMode,
  getIntegrationModes,
} from '../controllers/config.controller.js';

export default async function routes(app) {
  app.post('/config/client', createClientConfig);
  app.get('/config/client', getClientConfig);

  app.post('/config/mode', createIntegrationMode);
  app.get('/config/mode', getIntegrationModes);
}
