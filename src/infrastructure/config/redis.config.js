function normalizeNumber(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

export const redisConfig = Object.freeze({
  url: process.env.REDIS_URL || null,
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: normalizeNumber(process.env.REDIS_PORT, 6379),
  password: process.env.REDIS_PASSWORD || null,
  db: normalizeNumber(process.env.REDIS_DB, 0),
});

export const bullMqRedisConfig = Object.freeze({
  url: process.env.BULLMQ_REDIS_URL || process.env.REDIS_URL || null,
  host: process.env.BULLMQ_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1',
  port: normalizeNumber(process.env.BULLMQ_REDIS_PORT || process.env.REDIS_PORT, 6379),
  password: process.env.BULLMQ_REDIS_PASSWORD || process.env.REDIS_PASSWORD || null,
  db: normalizeNumber(process.env.BULLMQ_REDIS_DB, 0),
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export default redisConfig;

