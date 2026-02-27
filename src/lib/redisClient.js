import { createClient } from 'redis';
import logger from '../core/logger.js';

let redisClientPromise = null;

function resolveRedisConfig() {
  if (process.env.REDIS_URL) {
    return {
      url: process.env.REDIS_URL,
    };
  }

  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = Number(process.env.REDIS_PORT || 6379);
  const password = process.env.REDIS_PASSWORD;

  return {
    socket: {
      host,
      port,
    },
    ...(password ? { password } : {}),
  };
}

export async function getRedisClient() {
  if (redisClientPromise) {
    return redisClientPromise;
  }

  const client = createClient(resolveRedisConfig());

  client.on('error', (error) => {
    logger.warn('Redis client error', { error: error.message });
  });

  redisClientPromise = client.connect().then(() => client);
  return redisClientPromise;
}

export default {
  getRedisClient,
};
