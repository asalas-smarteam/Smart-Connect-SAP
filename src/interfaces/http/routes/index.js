/* Register all HTTP routes exposed by the API interface. */
import healthRoutes from './health.routes.js';
import configRoutes from './config.routes.js';
import mappingRoutes from './mapping.routes.js';
import oauthRoutes from './oauth.routes.js';
import sapSyncRoutes from './sapSync.routes.js';
import dealMappingRoutes from './dealMapping.routes.js';
import ownerMappingRoutes from './ownerMapping.routes.js';
import internalRoutes from './internal.routes.js';
import webhookRoutes from './webhook.routes.js';
import sapCredentialsRoutes from './sapCredentials.routes.js';
import lineItemPriceRoutes from './lineItemPrice.routes.js';

export default async function routes(app) {
  app.register(healthRoutes);
  app.register(configRoutes);
  app.register(mappingRoutes);
  app.register(oauthRoutes);
  app.register(sapSyncRoutes);
  app.register(dealMappingRoutes);
  app.register(ownerMappingRoutes);
  app.register(sapCredentialsRoutes);
  app.register(lineItemPriceRoutes);
  app.register(internalRoutes);
  app.register(webhookRoutes);
}
