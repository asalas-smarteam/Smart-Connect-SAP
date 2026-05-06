import dotenv from 'dotenv';
import app from './app.js';
import db from '../infrastructure/database/master/master-db.js';
import logger from '../infrastructure/logger/logger.adapter.js';
import { closeAllConnections } from '../infrastructure/database/externalDb.js';
import { seedDefaultSapFilters } from '../infrastructure/database/seeds/defaultSapFilters.seed.js';
import { seedMasterClientConfigs } from '../infrastructure/database/seeds/masterClientConfigs.seed.js';
import { closeSapSyncQueue } from '../infrastructure/queue/sap-sync.queue.adapter.js';
import { closeSharedBullMQConnection } from '../infrastructure/queue/bullmqRedis.js';
import { disconnectTenantConnections } from '../infrastructure/database/tenant/tenant-db.js';
import appConfig from '../infrastructure/config/app.config.js';

dotenv.config();

const { connect, disconnect } = db;

let isClosingConnection = false;
let isConnectionClosed = false;

const closeDatabaseConnection = async () => {
  if (isConnectionClosed || isClosingConnection) {
    return;
  }

  isClosingConnection = true;

  try {
    await closeSapSyncQueue();
    await closeSharedBullMQConnection();
    await disconnect();
    await disconnectTenantConnections();
    isConnectionClosed = true;
    logger.info('🧹 MongoDB connection closed.');
    await closeAllConnections();
  } catch (error) {
    logger.error({
      msg: 'Error closing MongoDB connection',
      error,
    });
  } finally {
    isClosingConnection = false;
  }
};

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.once(signal, () => {
    closeDatabaseConnection()
      .catch((error) => {
        logger.error({
          msg: 'Error during shutdown',
          error,
        });
      })
      .finally(() => {
        process.exit(0);
      });
  });
});

process.once('beforeExit', () => {
  closeDatabaseConnection().catch((error) => {
    logger.error({
      msg: 'Error closing database connection before exit',
      error,
    });
  });
});


const start = async () => {
  try {
    const masterConnection = await connect();
    await seedDefaultSapFilters(masterConnection);
    await seedMasterClientConfigs(masterConnection);
    await app.listen({ port: appConfig.port, host: '0.0.0.0' });
    logger.info(`🚀 Server running on http://localhost:${appConfig.port}`);

  } catch (err) {
    app.log.error(err);
    await closeDatabaseConnection();
    process.exit(1);
  }
};

start();
