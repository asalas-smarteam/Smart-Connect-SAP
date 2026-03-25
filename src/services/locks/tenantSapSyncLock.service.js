import crypto from 'crypto';
import { getSharedBullMQConnection } from '../../lib/bullmqRedis.js';

const DEFAULT_LOCK_TTL_MS = Number(process.env.SAP_SYNC_TENANT_LOCK_TTL_MS || 10 * 60 * 1000);

function buildLockKey(tenantKey) {
  return `lock:sap-sync:${tenantKey}`;
}

function buildLockToken() {
  return crypto.randomBytes(16).toString('hex');
}

export async function acquireTenantSapSyncLock(tenantKey, ttlMs = DEFAULT_LOCK_TTL_MS) {
  const connection = getSharedBullMQConnection();
  const key = buildLockKey(tenantKey);
  const token = buildLockToken();
  const result = await connection.set(key, token, 'PX', ttlMs, 'NX');

  if (result !== 'OK') {
    return null;
  }

  return {
    key,
    token,
    ttlMs,
  };
}

export async function releaseTenantSapSyncLock(lock) {
  if (!lock?.key || !lock?.token) {
    return false;
  }

  const connection = getSharedBullMQConnection();
  const releaseScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  const released = await connection.eval(releaseScript, 1, lock.key, lock.token);
  return released === 1;
}

export async function extendTenantSapSyncLock(lock, ttlMs = DEFAULT_LOCK_TTL_MS) {
  if (!lock?.key || !lock?.token) {
    return false;
  }

  const connection = getSharedBullMQConnection();
  const extendScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  const extended = await connection.eval(extendScript, 1, lock.key, lock.token, String(ttlMs));
  return extended === 1;
}

export { buildLockKey };
