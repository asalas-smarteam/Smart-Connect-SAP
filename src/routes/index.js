/* Register all routes */
import echoRoutes from './echo.routes.js';
import healthRoutes from './health.routes.js';
import configRoutes from './config.routes.js';

export default async function routes(app) {
  app.register(echoRoutes, { prefix: '/echo_test' });
  app.register(healthRoutes);
  app.register(configRoutes);
}
