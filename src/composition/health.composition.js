import GetHealthStatus from '#application/use-cases/GetHealthStatus.js';
import { APP_VERSION } from '#infrastructure/config/appMetadata.js';
import MongooseDatabaseStatusProvider from '#infrastructure/database/MongooseDatabaseStatusProvider.js';
import { createHealthController } from '#interfaces/http/controllers/health.controller.js';

export function buildGetHealthStatus() {
  return new GetHealthStatus({
    databaseStatusProvider: new MongooseDatabaseStatusProvider(),
    version: APP_VERSION,
  });
}

export function buildHealthController() {
  return createHealthController({
    getHealthStatus: buildGetHealthStatus(),
  });
}

export default buildHealthController;
