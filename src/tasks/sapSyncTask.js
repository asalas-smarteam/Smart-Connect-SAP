import cron from 'node-cron';
import syncService from '../services/syncService.js';
import { getTenantModels } from '../config/tenantDatabase.js';
import { listActiveTenants } from '../utils/tenantSubscriptions.js';

export async function runSapSyncOnce() {
  const activeTenants = await listActiveTenants();

  for (const { client } of activeTenants) {
    const tenantModels = await getTenantModels(client.tenantKey);
    const { ClientConfig } = tenantModels;
    const activeConfigs = await ClientConfig.find({ active: true });

    for (const config of activeConfigs) {
      await syncService.run(config, tenantModels);
    }
  }
}

export default function startSapSync() {
  const sapSyncJob = cron.schedule('*/1 * * * *', runSapSyncOnce, { scheduled: false });

  return sapSyncJob;
}
