import cron from 'node-cron';
import syncService from '../services/syncService.js';
import { ClientConfig } from '../config/database.js';

export default function startSapSync() {
  const sapSyncJob = cron.schedule(
    '*/1 * * * *',
    async () => {
      const activeConfigs = await ClientConfig.findAll({ where: { active: true } });

      for (const config of activeConfigs) {
        await syncService.run(config.id);
      }
    },
    { scheduled: false }
  );

  return sapSyncJob;
}
