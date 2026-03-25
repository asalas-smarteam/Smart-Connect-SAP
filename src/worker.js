import dotenv from 'dotenv';
import db from './config/database.js';
import logger from './core/logger.js';
import { closeAllConnections } from './utils/externalDb.js';
import { disconnectTenantConnections } from './config/tenantDatabase.js';
import { closeSapSyncQueue } from './queues/sapSync.queue.js';
import { closeSharedBullMQConnection } from './lib/bullmqRedis.js';
import { startSapSyncWorker } from './workers/sapSync.worker.js';

dotenv.config();

const { connect, disconnect } = db;
let workerInstance = null;
let isClosing = false;

async function shutdownWorker() {
  if (isClosing) {
    return;
  }

  isClosing = true;
  logger.info({ msg: 'Shutting down SAP sync worker process' });

  try {
    if (workerInstance) {
      await workerInstance.close();
      workerInstance = null;
    }
    await closeSapSyncQueue();
    await closeSharedBullMQConnection();
    await closeAllConnections();
    await disconnectTenantConnections();
    await disconnect();
  } catch (error) {
    logger.error({
      msg: 'Error during worker shutdown',
      error: error.message,
    });
  } finally {
    isClosing = false;
  }
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.once(signal, () => {
    shutdownWorker()
      .catch((error) => {
        logger.error({
          msg: 'Unhandled worker shutdown error',
          error: error.message,
        });
      })
      .finally(() => process.exit(0));
  });
});

async function start() {
  try {
    await connect();
    workerInstance = startSapSyncWorker();
    logger.info({ msg: 'SAP sync worker process is running' });
  } catch (error) {
    logger.error({
      msg: 'Failed starting SAP sync worker process',
      error: error.message,
    });
    await shutdownWorker();
    process.exit(1);
  }
}

start();
