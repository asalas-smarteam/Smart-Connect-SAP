import {
  activateSapSyncConfig,
  deactivateSapSyncConfig,
  deleteTenantSapSyncJobs,
  getSapSyncJobsSnapshot,
  resyncSapSyncScheduler,
  runSapSyncConfigManually,
  runTenantConfigNow,
  syncTenantConfigSchedule,
  triggerSapSync,
  triggerWebHook,
} from '../controllers/sapSync.controller.js';
import { internalKeyAuthOnly } from '../middleware/internalAuth.js';
import { tenantResolver } from '../middleware/tenantResolver.js';

export default async function routes(app) {
  app.post('/sap-sync/run', triggerSapSync);
  app.post('/sap-sync/runWebHook', triggerWebHook);

  app.get('/sap-sync/jobs', { preHandler: internalKeyAuthOnly }, getSapSyncJobsSnapshot);
  app.post('/sap-sync/jobs/activate', { preHandler: internalKeyAuthOnly }, activateSapSyncConfig);
  app.post('/sap-sync/jobs/deactivate', { preHandler: internalKeyAuthOnly }, deactivateSapSyncConfig);
  app.post('/sap-sync/jobs/run', { preHandler: internalKeyAuthOnly }, runSapSyncConfigManually);
  app.post('/sap-sync/jobs/resync', { preHandler: internalKeyAuthOnly }, resyncSapSyncScheduler);
  app.delete('/sap-sync/jobs/tenant/:tenantKey', { preHandler: internalKeyAuthOnly }, deleteTenantSapSyncJobs);

  app.post('/sap-sync/config/:id/run', { preHandler: tenantResolver }, runTenantConfigNow);
  app.post('/sap-sync/config/:id/sync-schedule', { preHandler: tenantResolver }, syncTenantConfigSchedule);
}
