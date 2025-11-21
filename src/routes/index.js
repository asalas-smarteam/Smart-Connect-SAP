/* Register all routes */
import echoRoutes from './echo.routes.js';

export default async function routes(app) {
  app.register(echoRoutes, { prefix: '/echo_test' });
}
