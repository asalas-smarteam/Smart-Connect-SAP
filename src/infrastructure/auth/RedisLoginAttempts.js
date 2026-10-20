import crypto from 'crypto';
import { getRedisClient } from '../cache/redisClient.js';
import defaultLogger from '../logger/logger.adapter.js';
import { normalizeEmail } from '#domain/panel/accounts.js';

const KEY_PREFIX = 'panel:login:fail:';
// INCR y EXPIRE en una sola operación atómica. Si la clave quedó sin TTL (por ejemplo, porque el
// proceso murió entre los dos comandos) se le vuelve a poner: así nunca hay un bloqueo eterno.
const CONSUME_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  "if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
  'return count',
].join('\n');
const MAX_MEMORY_ENTRIES = 10000;
const WARN_INTERVAL_MS = 60 * 1000;

function hashEmail(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs);
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Contador de intentos de login por clave (correo, o IP del cliente con otro keyPrefix). La
// clave se guarda como sha256 del valor normalizado: ni el correo ni la IP quedan en claro.
//
// El cliente `redis` v4 no falla rápido si Redis está caído: reintenta para siempre y los
// comandos quedan en cola. Por eso cada operación tiene timeout y, si falla, se usa un
// contador en memoria del proceso con el mismo límite durante `retryAfterMs`.
export class RedisLoginAttempts {
  constructor({
    getClient = getRedisClient,
    logger = defaultLogger,
    keyPrefix = KEY_PREFIX,
    maxAttempts = 5,
    windowSeconds = 900,
    timeoutMs = 1000,
    retryAfterMs = 30 * 1000,
    now = () => Date.now(),
  } = {}) {
    this.getClient = getClient;
    this.logger = logger;
    this.keyPrefix = keyPrefix;
    this.maxAttempts = maxAttempts;
    this.windowSeconds = windowSeconds;
    this.timeoutMs = timeoutMs;
    this.retryAfterMs = retryAfterMs;
    this.now = now;
    this.memory = new Map();
    this.redisUnavailableUntil = 0;
    this.lastWarnAt = 0;
  }

  // Cuenta el intento y devuelve { blocked: true } a partir del intento maxAttempts + 1 dentro
  // de la ventana. Un login correcto llama a reset, así que solo se acumulan los fallidos.
  async consume(email) {
    const key = this.#key(email);
    const count = await this.#run(
      async (client) => Number(await client.eval(CONSUME_SCRIPT, {
        keys: [key],
        arguments: [String(this.windowSeconds)],
      })),
      () => this.#memoryIncrement(key)
    );

    return { blocked: count > this.maxAttempts, firstBlocked: count === this.maxAttempts + 1 };
  }

  async reset(email) {
    const key = this.#key(email);
    this.memory.delete(key);
    await this.#run(
      async (client) => {
        await client.del(key);
      },
      () => undefined
    );
  }

  #key(email) {
    return `${this.keyPrefix}${hashEmail(email)}`;
  }

  async #run(operation, fallback) {
    if (this.now() < this.redisUnavailableUntil) {
      return fallback();
    }

    try {
      const client = await withTimeout(Promise.resolve().then(() => this.getClient()), this.timeoutMs);
      return await withTimeout(Promise.resolve().then(() => operation(client)), this.timeoutMs);
    } catch (error) {
      this.redisUnavailableUntil = this.now() + this.retryAfterMs;
      this.#warn(error);
      return fallback();
    }
  }

  #warn(error) {
    const now = this.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) {
      return;
    }

    this.lastWarnAt = now;
    this.logger.warn({
      msg: 'Panel login attempts: Redis unavailable, using in-memory counter',
      error: error?.message,
    });
  }

  #memoryCount(key) {
    const entry = this.memory.get(key);
    if (!entry) {
      return 0;
    }

    if (entry.expiresAt <= this.now()) {
      this.memory.delete(key);
      return 0;
    }

    return entry.count;
  }

  #memoryIncrement(key) {
    const count = this.#memoryCount(key);
    const existing = this.memory.get(key);
    const expiresAt = existing ? existing.expiresAt : this.now() + this.windowSeconds * 1000;

    this.memory.delete(key);
    this.memory.set(key, { count: count + 1, expiresAt });

    if (this.memory.size > MAX_MEMORY_ENTRIES) {
      const oldestKey = this.memory.keys().next().value;
      this.memory.delete(oldestKey);
    }

    return count + 1;
  }
}

export default RedisLoginAttempts;
