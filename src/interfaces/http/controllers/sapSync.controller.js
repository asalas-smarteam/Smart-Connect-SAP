import { buildSapSyncAdmin } from '#composition/sap-sync.composition.js';

function createSapSyncController({ sapSyncAdmin = buildSapSyncAdmin() } = {}) {
  return {
    triggerSapSync: async (req, reply) =>  {
  try {
    await sapSyncAdmin.runSapSyncOnce();
    reply.code(200).send({ message: 'SAP sync jobs executed successfully' });
  } catch (error) {
    req.log.error({ msg: 'Error executing SAP sync jobs manually', error });
    reply.code(500).send({ message: 'Failed to execute SAP sync jobs', error: error.message });
  }
},

    triggerWebHook: async (req, reply) => {
  try {
    const data = await sapSyncAdmin.runWebhookProcessorManualOnce();
    reply.code(200).send({ message: 'Webhook processing executed successfully', data });
  } catch (error) {
    req.log.error({ msg: 'Error executing webhook processing manually', error });
    reply.code(500).send({ message: 'Failed to execute webhook processing', error: error.message });
  }
},

    getSapSyncJobsSnapshot: async (req, reply) => {
  try {
    const data = await sapSyncAdmin.getQueueDashboardSnapshot();
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error fetching SAP sync queue snapshot', error });
    return reply.code(500).send({ ok: false, message: error.message });
  }
},

    activateSapSyncConfig: async (req, reply) => {
  try {
    const { tenantKey, configId } = req.body || {};
    const data = await sapSyncAdmin.setConfigActiveState({ tenantKey, configId, active: true });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error activating SAP sync config', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
},

    deactivateSapSyncConfig: async (req, reply) => {
  try {
    const { tenantKey, configId } = req.body || {};
    const data = await sapSyncAdmin.setConfigActiveState({ tenantKey, configId, active: false });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error deactivating SAP sync config', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
},

    runSapSyncConfigManually: async (req, reply) => {
  try {
    const { tenantKey, configId } = req.body || {};
    const data = await sapSyncAdmin.runConfigManualJob({ tenantKey, configId });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error queuing manual SAP sync config job', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
},

    resyncSapSyncScheduler: async (req, reply) => {
  try {
    const data = await sapSyncAdmin.resyncSchedulerFromDatabase();
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error resyncing SAP sync scheduler', error });
    return reply.code(500).send({ ok: false, message: error.message });
  }
},

    deleteTenantSapSyncJobs: async (req, reply) => {
  try {
    const { tenantKey } = req.params || {};
    const data = await sapSyncAdmin.purgeTenantJobs(tenantKey);
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error deleting tenant SAP sync jobs', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
},

    runTenantConfigNow: async (req, reply) => {
  try {
    const tenantKey = req.tenantKey;
    const { id: configId } = req.params;
    const data = await sapSyncAdmin.runConfigManualJob({ tenantKey, configId });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error queuing tenant manual SAP sync config job', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
},

    syncTenantConfigSchedule: async (req, reply) => {
  try {
    const tenantKey = req.tenantKey;
    const { id: configId } = req.params;
    const data = await sapSyncAdmin.syncSingleConfigSchedule({ tenantKey, configId });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error syncing tenant config schedule', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
},
  };
}

const sapSyncController = createSapSyncController();

export const {
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
} = sapSyncController;

export { createSapSyncController };

export default sapSyncController;
