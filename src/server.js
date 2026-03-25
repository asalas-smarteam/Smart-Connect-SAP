import dotenv from 'dotenv';
import app from './app.js';
import db from './config/database.js';
import logger from './core/logger.js';
import { closeAllConnections } from './utils/externalDb.js';
import { seedDefaultSapFilters } from '../database/seeds/defaultSapFilters.seed.js';
import { seedMasterClientConfigs } from '../database/seeds/masterClientConfigs.seed.js';
import { closeSapSyncQueue } from './queues/sapSync.queue.js';
import { closeSharedBullMQConnection } from './lib/bullmqRedis.js';
import { disconnectTenantConnections } from './config/tenantDatabase.js';

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
    const PORT = process.env.PORT || 3000;
    const masterConnection = await connect();
    await seedDefaultSapFilters(masterConnection);
    await seedMasterClientConfigs(masterConnection);
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`🚀 Server running on http://localhost:${PORT}`);

  } catch (err) {
    app.log.error(err);
    await closeDatabaseConnection();
    process.exit(1);
  }
};

start();
