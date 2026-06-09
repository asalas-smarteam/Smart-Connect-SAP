import cron from 'node-cron';
import {
  buildSapSyncTenantRepository,
  buildSyncSapConfigToHubspot,
} from '#composition/sap-sync.composition.js';
import { listActiveTenants } from '#infrastructure/tenants/tenantSubscriptions.js';

export async function runSapSyncOnce({
  tenantRepository = buildSapSyncTenantRepository(),
  syncUseCase = buildSyncSapConfigToHubspot(),
  tenantProvider = listActiveTenants,
} = {}) {
  const activeTenants = await tenantProvider();

  for (const { client } of activeTenants) {
    const { tenantModels, configs } = await tenantRepository.findActiveConfigs(client.tenantKey);

    for (const config of configs) {
      await syncUseCase.execute({
        config,
        tenantContext: {
          tenantKey: client.tenantKey,
          tenantModels,
        },
      });
    }
  }
}

export default function startSapSync() {
  if (false) { // delete in prod
    const sapSyncJob = cron.schedule('*/1 * * * *', runSapSyncOnce, { scheduled: false });
    return sapSyncJob;
  }
}
