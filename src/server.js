import dotenv from 'dotenv';
import app from './app.js';
import db from './config/database.js';
import logger from './core/logger.js';

dotenv.config();

const { sequelize } = db;

let isClosingConnection = false;
let isConnectionClosed = false;

const closeDatabaseConnection = async () => {
  if (isConnectionClosed || isClosingConnection) {
    return;
  }

  isClosingConnection = true;

  try {
    if (sequelize) {
      await sequelize.close();
      isConnectionClosed = true;
      logger.info('🧹 Supabase database connection closed.');
    }
  } catch (error) {
    logger.error({
      msg: 'Error closing Supabase database connection',
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
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`🚀 Server running on http://localhost:${PORT}`);

  } catch (err) {
    app.log.error(err);
    await closeDatabaseConnection();
    process.exit(1);
  }
};

start();
