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
import { adminTenantAuth } from '../middlewares/adminAuth.js';
import { internalKeyAuthOnly } from '../middlewares/internalAuth.js';

export default async function routes(app) {
  app.post('/config/client', { preHandler: adminTenantAuth }, createClientConfig);
  app.get('/config/client', { preHandler: adminTenantAuth }, getClientConfig);
  app.patch('/config/client/:id', { preHandler: adminTenantAuth }, patchClientConfig);

  app.post('/config/mode', { preHandler: adminTenantAuth }, createIntegrationMode);
  app.get('/config/mode', { preHandler: adminTenantAuth }, getIntegrationModes);

  // Plantillas que se replican a cada tenant al instalar: tocarlas cambia todas las
  // instalaciones futuras, así que no dependen de ningún tenant pero sí de la llave interna.
  app.post('/master/config/client', { preHandler: internalKeyAuthOnly }, createMasterClientConfigHandler);
  app.get('/master/config/client', { preHandler: internalKeyAuthOnly }, getMasterClientConfigs);
  app.patch('/master/config/client/:id', { preHandler: internalKeyAuthOnly }, patchMasterClientConfigHandler);
  app.delete('/master/config/client/:id', { preHandler: internalKeyAuthOnly }, deleteMasterClientConfigHandler);
}
