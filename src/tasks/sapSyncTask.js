import cron from 'node-cron';
import sapService from '../integrations/sap/sapService.js';
import { ClientConfig } from '../config/database.js';

export function startSapSync() {
  const sapSyncJob = cron.schedule(
    '*/5 * * * *',
    async () => {
      const activeConfigs = await ClientConfig.findAll({ where: { active: true } });

      for (const config of activeConfigs) {
        await sapService.fetchData(config.id);
      }
    },
    { scheduled: false }
  );

  return sapSyncJob;
}
