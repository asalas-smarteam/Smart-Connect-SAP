import cron from 'node-cron';
import { listActiveTenants } from '../../../infrastructure/tenants/tenantSubscriptions.js';
import MongooseSapSyncTenantRepository from '../../../infrastructure/database/repositories/MongooseSapSyncTenantRepository.js';
import MongooseSyncLogRepository from '../../../infrastructure/database/repositories/MongooseSyncLogRepository.js';
import MappingSyncRepository from '../../../infrastructure/repositories/MappingSyncRepository.js';
import HubspotSyncAdapter from '../../../infrastructure/hubspot/HubspotSyncAdapter.js';
import SapSyncDataAdapter from '../../../infrastructure/sap/SapSyncDataAdapter.js';
import SyncSapConfigToHubspot from '../../../application/use-cases/SyncSapConfigToHubspot.js';

function createSyncUseCase() {
  return new SyncSapConfigToHubspot({
    sapDataSource: new SapSyncDataAdapter(),
    mappingRepository: new MappingSyncRepository(),
    hubspotSyncTarget: new HubspotSyncAdapter(),
    syncLogRepository: new MongooseSyncLogRepository(),
  });
}

export async function runSapSyncOnce({
  tenantRepository = new MongooseSapSyncTenantRepository(),
  syncUseCase = createSyncUseCase(),
  tenantProvider = listActiveTenants,
} = {}) {
  const activeTenants = await tenantProvider();

  for (const { client } of activeTenants) {
    const { tenantModels, configs } = await tenantRepository.findActiveConfigs(client.tenantKey);

    for (const config of configs) {
      await syncUseCase.execute({ config, tenantModels });
    }
  }
}

export default function startSapSync() {
  if (false) { // delete in prod
    const sapSyncJob = cron.schedule('*/1 * * * *', runSapSyncOnce, { scheduled: false });
    return sapSyncJob;
  }
}

