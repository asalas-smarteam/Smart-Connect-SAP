import { APP_VERSION } from '../config/appMetadata.js';
import GetHealthStatus from '../application/use-cases/GetHealthStatus.js';
import MongooseDatabaseStatusProvider from '../infrastructure/database/MongooseDatabaseStatusProvider.js';
import { createHealthController } from '../interfaces/http/controllers/health.controller.js';

const getHealthStatus = new GetHealthStatus({
  databaseStatusProvider: new MongooseDatabaseStatusProvider(),
  version: APP_VERSION,
});

export const health = createHealthController({ getHealthStatus });
