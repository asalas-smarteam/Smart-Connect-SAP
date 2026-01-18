import cron from 'node-cron';
import syncService from '../services/syncService.js';
import { SaaSClient, Subscription } from '../config/database.js';
import { getTenantModels } from '../config/tenantDatabase.js';

export async function runSapSyncOnce() {
  const activeClients = await SaaSClient.find({ status: 'active' });

  for (const client of activeClients) {
    const subscription = await Subscription.findOne({ clientId: client._id }).sort({ startedAt: -1 });
    if (!subscription || subscription.status !== 'active' || subscription.paymentStatus !== 'paid') {
      continue;
    }

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
