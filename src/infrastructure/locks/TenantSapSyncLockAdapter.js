import {
  acquireTenantSapSyncLock,
  extendTenantSapSyncLock,
  releaseTenantSapSyncLock,
} from './tenantSapSyncLock.service.js';

export class TenantSapSyncLockAdapter {
  async acquire(tenantKey) {
    return acquireTenantSapSyncLock(tenantKey);
  }

  async extend(lock, ttlMs) {
    return extendTenantSapSyncLock(lock, ttlMs);
  }

  async release(lock) {
    return releaseTenantSapSyncLock(lock);
  }
}

export default TenantSapSyncLockAdapter;

