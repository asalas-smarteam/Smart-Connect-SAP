import {
  createClientConfig,
  getClientConfig,
  patchClientConfig,
  createIntegrationMode,
  getIntegrationModes,
} from '../controllers/config.controller.js';
import {
  createMasterClientConfigHandler,
  deleteMasterClientConfigHandler,
  getMasterClientConfigs,
  patchMasterClientConfigHandler,
} from '../controllers/master/masterClientConfig.controller.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.post('/config/client', { preHandler: tenantResolver }, createClientConfig);
  app.get('/config/client', { preHandler: tenantResolver }, getClientConfig);
  app.patch('/config/client/:id', { preHandler: tenantResolver }, patchClientConfig);

  app.post('/config/mode', { preHandler: tenantResolver }, createIntegrationMode);
  app.get('/config/mode', { preHandler: tenantResolver }, getIntegrationModes);

  app.post('/master/config/client', createMasterClientConfigHandler);
  app.get('/master/config/client', getMasterClientConfigs);
  app.patch('/master/config/client/:id', patchMasterClientConfigHandler);
  app.delete('/master/config/client/:id', deleteMasterClientConfigHandler);
}
