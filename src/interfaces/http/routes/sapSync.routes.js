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
import { adminTenantAuth } from '../middlewares/adminAuth.js';
import { internalKeyAuthOnly } from '../middlewares/internalAuth.js';

export default async function routes(app) {
  // Disparos manuales para probar tareas y webhooks. Toman el tenant del body (tenantID), no
  // del resolver, así que alcanza con la llave interna.
  app.post('/sap-sync/run', { preHandler: internalKeyAuthOnly }, triggerSapSync);
  app.post('/sap-sync/runWebHook', { preHandler: internalKeyAuthOnly }, triggerWebHook);

  app.get('/sap-sync/jobs', { preHandler: internalKeyAuthOnly }, getSapSyncJobsSnapshot);
  app.post('/sap-sync/jobs/activate', { preHandler: internalKeyAuthOnly }, activateSapSyncConfig);
  app.post('/sap-sync/jobs/deactivate', { preHandler: internalKeyAuthOnly }, deactivateSapSyncConfig);
  app.post('/sap-sync/jobs/run', { preHandler: internalKeyAuthOnly }, runSapSyncConfigManually);
  app.post('/sap-sync/jobs/resync', { preHandler: internalKeyAuthOnly }, resyncSapSyncScheduler);
  app.delete('/sap-sync/jobs/tenant/:tenantKey', { preHandler: internalKeyAuthOnly }, deleteTenantSapSyncJobs);

  app.post('/sap-sync/config/:id/run', { preHandler: adminTenantAuth }, runTenantConfigNow);
  app.post('/sap-sync/config/:id/sync-schedule', { preHandler: adminTenantAuth }, syncTenantConfigSchedule);
}
