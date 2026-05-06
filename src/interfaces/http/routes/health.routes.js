import { APP_VERSION } from '../../../config/appMetadata.js';
import GetHealthStatus from '../../../application/use-cases/GetHealthStatus.js';
import MongooseDatabaseStatusProvider from '../../../infrastructure/database/MongooseDatabaseStatusProvider.js';
import { createHealthController } from '../controllers/health.controller.js';

function buildHealthController() {
  const getHealthStatus = new GetHealthStatus({
    databaseStatusProvider: new MongooseDatabaseStatusProvider(),
    version: APP_VERSION,
  });

  return createHealthController({ getHealthStatus });
}

export default async function healthRoutes(app) {
  app.get('/health', buildHealthController());
}
