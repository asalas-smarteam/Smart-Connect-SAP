import SyncSapConfigToHubspot from '#application/use-cases/SyncSapConfigToHubspot.js';
import MongooseSapSyncTenantRepository from '#infrastructure/database/repositories/MongooseSapSyncTenantRepository.js';
import MongooseSyncLogRepository from '#infrastructure/database/repositories/MongooseSyncLogRepository.js';
import HubspotSyncAdapter from '#infrastructure/hubspot/HubspotSyncAdapter.js';
import TenantSapSyncLockAdapter from '#infrastructure/locks/TenantSapSyncLockAdapter.js';
import MappingSyncRepository from '#infrastructure/repositories/MappingSyncRepository.js';
import SapSyncDataAdapter from '#infrastructure/sap/SapSyncDataAdapter.js';
import sapSyncAdminAdapter from '#infrastructure/scheduler/SapSyncAdminAdapter.js';

export function buildSyncSapConfigToHubspot() {
  return new SyncSapConfigToHubspot({
    sapDataSource: new SapSyncDataAdapter(),
    mappingRepository: new MappingSyncRepository(),
    hubspotSyncTarget: new HubspotSyncAdapter(),
    syncLogRepository: new MongooseSyncLogRepository(),
  });
}

export function buildSapSyncTenantRepository() {
  return new MongooseSapSyncTenantRepository();
}

export function buildTenantSapSyncLockAdapter() {
  return new TenantSapSyncLockAdapter();
}

export function buildSapSyncAdmin() {
  return sapSyncAdminAdapter;
}

export default buildSyncSapConfigToHubspot;
