/* Register all routes */
import echoRoutes from './echo.routes.js';
import healthRoutes from './health.routes.js';
import configRoutes from './config.routes.js';
import mappingRoutes from './mapping.routes.js';
import dbTestRoutes from './dbTest.routes.js';
import oauthRoutes from './oauth.routes.js';
import testHSRoutes from './testHS.routes.js';
import hubspotTestRoutes from './hubspotTest.routes.js';
import sapSyncRoutes from './sapSync.routes.js';
import dealMappingRoutes from './dealMapping.routes.js';
import dealOwnerMappingRoutes from './dealOwnerMapping.routes.js';
import associationTestRoutes from './associationTest.routes.js';
import internalRoutes from './internal.routes.js';

export default async function routes(app) {
  app.register(echoRoutes, { prefix: '/echo_test' });
  app.register(healthRoutes);
  app.register(configRoutes);
  app.register(mappingRoutes);
  app.register(dbTestRoutes);
  app.register(oauthRoutes);
  app.register(testHSRoutes);
  app.register(hubspotTestRoutes);
  app.register(sapSyncRoutes);
  app.register(dealMappingRoutes);
  app.register(dealOwnerMappingRoutes);
  app.register(associationTestRoutes);
  app.register(internalRoutes);
}
