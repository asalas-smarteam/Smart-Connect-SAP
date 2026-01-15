import cron from 'node-cron';
import syncService from '../services/syncService.js';
import { ClientConfig } from '../config/database.js';

export async function runSapSyncOnce() {
  const activeConfigs = await ClientConfig.find({ active: true });

  for (const config of activeConfigs) {
    await syncService.run(config);
  }
}

export default function startSapSync() {
  const sapSyncJob = cron.schedule('*/1 * * * *', runSapSyncOnce, { scheduled: false });

  return sapSyncJob;
}
