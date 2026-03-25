import IORedis from 'ioredis';
import logger from '../core/logger.js';

let sharedConnection = null;

function resolveBullMQRedisOptions() {
  const redisUrl = process.env.BULLMQ_REDIS_URL || process.env.REDIS_URL;
  if (redisUrl) {
    return {
      url: redisUrl,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    };
  }

  const host = process.env.BULLMQ_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1';
  const port = Number(process.env.BULLMQ_REDIS_PORT || process.env.REDIS_PORT || 6379);
  const password = process.env.BULLMQ_REDIS_PASSWORD || process.env.REDIS_PASSWORD;
  const db = Number(process.env.BULLMQ_REDIS_DB || 0);

  return {
    host,
    port,
    db,
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
    lazyConnect: true,
  };
}

function registerConnectionListeners(connection, label) {
  connection.on('error', (error) => {
    logger.warn({
      msg: `BullMQ Redis ${label} connection error`,
      error: error.message,
    });
  });

  connection.on('connect', () => {
    logger.info({ msg: `BullMQ Redis ${label} connected` });
  });
}

export function createBullMQConnection(label = 'client') {
  const connection = new IORedis(resolveBullMQRedisOptions());
  registerConnectionListeners(connection, label);
  return connection;
}

export function getSharedBullMQConnection() {
  if (sharedConnection) {
    return sharedConnection;
  }

  sharedConnection = createBullMQConnection('shared');
  return sharedConnection;
}

export async function closeSharedBullMQConnection() {
  if (!sharedConnection) {
    return;
  }

  await sharedConnection.quit();
  sharedConnection = null;
}
