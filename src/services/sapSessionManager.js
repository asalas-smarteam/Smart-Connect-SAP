import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import logger from '../core/logger.js';
import { getRedisClient } from '../lib/redisClient.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const LOCK_PREFIX = 'sap:lock:';
const SESSION_PREFIX = 'sap:session:';
const SESSION_TTL_SAFETY_SECONDS = 20;
const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;
const LOCK_MS = 12000;
const WAIT_TIMEOUT_MS = 10000;
const MAX_BACKOFF_MS = 2000;

function buildAuthPayload(config) {
  const payload = {
    UserName: config?.serviceLayerUsername,
    Password: config?.serviceLayerPassword,
  };

  if (config?.serviceLayerCompanyDB) {
    payload.CompanyDB = config.serviceLayerCompanyDB;
  }

  return payload;
}

function readSessionCookie(response) {
  const setCookie = response?.headers?.['set-cookie'] || [];
  const sessionCookie = setCookie.find((cookie) => cookie.startsWith('B1SESSION='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

function resolveTenantKey(config = {}) {
  if (config.tenantId) {
    return String(config.tenantId);
  }

  if (config.tenantKey) {
    return String(config.tenantKey);
  }

  const stableBase = [
    String(config?.serviceLayerBaseUrl || '').trim().toLowerCase(),
    String(config?.clientConfigId || config?._id || ''),
  ].join('|');

  if (!stableBase.replace('|', '').trim()) {
    throw new Error('Unable to resolve SAP tenant key');
  }

  return crypto.createHash('sha256').update(stableBase).digest('hex');
}

function sessionKey(tenantKey) {
  return `${SESSION_PREFIX}${tenantKey}`;
}

function lockKey(tenantKey) {
  return `${LOCK_PREFIX}${tenantKey}`;
}

function computeSessionTtlSeconds(sessionTimeoutMinutes) {
  const raw = Number(sessionTimeoutMinutes || DEFAULT_SESSION_TIMEOUT_MINUTES) * 60;
  const ttl = Math.max(30, Math.floor(raw - SESSION_TTL_SAFETY_SECONDS));
  return ttl;
}

async function releaseLock(redis, key, value) {
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  await redis.eval(lua, {
    keys: [key],
    arguments: [value],
  });
}

async function readSession(redis, tenantKey) {
  const raw = await redis.get(sessionKey(tenantKey));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    await redis.del(sessionKey(tenantKey));
    return null;
  }
}

async function loginAndStoreSession(redis, config, tenantKey) {
  const baseUrl = String(config?.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');
  const loginUrl = `${baseUrl}/b1s/v2/Login`;

  const loginResponse = await axios.post(loginUrl, buildAuthPayload(config), { httpsAgent });
  const cookie = readSessionCookie(loginResponse);
  if (!cookie) {
    throw new Error('Unable to establish SAP Service Layer session');
  }

  const sessionTimeoutMinutes = Number(
    loginResponse?.data?.SessionTimeout || DEFAULT_SESSION_TIMEOUT_MINUTES
  );
  const ttlSeconds = computeSessionTtlSeconds(sessionTimeoutMinutes);

  const payload = {
    cookie,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    sessionTimeoutMinutes,
  };

  await redis.set(sessionKey(tenantKey), JSON.stringify(payload), {
    EX: ttlSeconds,
  });

  logger.info('SAP Service Layer session renewed', {
    tenantKey,
    sessionTimeoutMinutes,
    ttlSeconds,
  });

  return payload;
}

async function waitForSession(redis, tenantKey) {
  const startedAt = Date.now();
  let delay = 100;

  while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
    const cachedSession = await readSession(redis, tenantKey);
    if (cachedSession?.cookie) {
      return cachedSession;
    }

    logger.info('Waiting SAP session lock release', {
      tenantKey,
      nextRetryInMs: delay,
    });

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(MAX_BACKOFF_MS, delay * 2);
  }

  throw new Error(`Timeout while waiting SAP session lock for tenant ${tenantKey}`);
}

const sapSessionManager = {
  resolveTenantKey,

  async getSessionCookie(config) {
    const tenantKey = resolveTenantKey(config);
    const redis = await getRedisClient();

    const existingSession = await readSession(redis, tenantKey);
    if (existingSession?.cookie) {
      return {
        tenantKey,
        cookie: existingSession.cookie,
      };
    }

    const lockValue = crypto.randomUUID();
    const acquired = await redis.set(lockKey(tenantKey), lockValue, {
      NX: true,
      PX: LOCK_MS,
    });

    if (acquired) {
      try {
        const refreshed = await loginAndStoreSession(redis, config, tenantKey);
        return {
          tenantKey,
          cookie: refreshed.cookie,
        };
      } finally {
        await releaseLock(redis, lockKey(tenantKey), lockValue);
      }
    }

    const waitedSession = await waitForSession(redis, tenantKey);
    return {
      tenantKey,
      cookie: waitedSession.cookie,
    };
  },

  async invalidateSession(configOrTenantKey) {
    const tenantKey =
      typeof configOrTenantKey === 'string'
        ? configOrTenantKey
        : resolveTenantKey(configOrTenantKey || {});
    const redis = await getRedisClient();
    await redis.del(sessionKey(tenantKey));
  },
};

export function isSessionInvalidError(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403) {
    return true;
  }

  const text = [
    error?.response?.data?.error?.message?.value,
    error?.response?.data?.message,
    error?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    text.includes('invalid session') ||
    text.includes('session timed out') ||
    text.includes('session timeout')
  );
}

export default sapSessionManager;
