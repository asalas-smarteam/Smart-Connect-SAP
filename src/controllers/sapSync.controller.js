import { runSapSyncOnce } from '../tasks/sapSyncTask.js';
import { runWebhookProcessorManualOnce } from '../tasks/webhookProcessorTask.js';
import {
  getQueueDashboardSnapshot,
  purgeTenantJobs,
  resyncSchedulerFromDatabase,
  runConfigManualJob,
  setConfigActiveState,
  syncSingleConfigSchedule,
} from '../services/scheduler/sapSyncQueueAdmin.service.js';

export const triggerSapSync = async (req, reply) =>  {
  try {
    await runSapSyncOnce();
    reply.code(200).send({ message: 'SAP sync jobs executed successfully' });
  } catch (error) {
    req.log.error({ msg: 'Error executing SAP sync jobs manually', error });
    reply.code(500).send({ message: 'Failed to execute SAP sync jobs', error: error.message });
  }
}

export const triggerWebHook = async (req, reply) => {
  try {
    const data = await runWebhookProcessorManualOnce();
    reply.code(200).send({ message: 'Webhook processing executed successfully', data });
  } catch (error) {
    req.log.error({ msg: 'Error executing webhook processing manually', error });
    reply.code(500).send({ message: 'Failed to execute webhook processing', error: error.message });
  }
}

export const getSapSyncJobsSnapshot = async (req, reply) => {
  try {
    const data = await getQueueDashboardSnapshot();
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error fetching SAP sync queue snapshot', error });
    return reply.code(500).send({ ok: false, message: error.message });
  }
};

export const activateSapSyncConfig = async (req, reply) => {
  try {
    const { tenantKey, configId } = req.body || {};
    const data = await setConfigActiveState({ tenantKey, configId, active: true });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error activating SAP sync config', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
};

export const deactivateSapSyncConfig = async (req, reply) => {
  try {
    const { tenantKey, configId } = req.body || {};
    const data = await setConfigActiveState({ tenantKey, configId, active: false });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error deactivating SAP sync config', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
};

export const runSapSyncConfigManually = async (req, reply) => {
  try {
    const { tenantKey, configId } = req.body || {};
    const data = await runConfigManualJob({ tenantKey, configId });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error queuing manual SAP sync config job', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
};

export const resyncSapSyncScheduler = async (req, reply) => {
  try {
    const data = await resyncSchedulerFromDatabase();
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error resyncing SAP sync scheduler', error });
    return reply.code(500).send({ ok: false, message: error.message });
  }
};

export const deleteTenantSapSyncJobs = async (req, reply) => {
  try {
    const { tenantKey } = req.params || {};
    const data = await purgeTenantJobs(tenantKey);
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error deleting tenant SAP sync jobs', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
};

export const runTenantConfigNow = async (req, reply) => {
  try {
    const tenantKey = req.tenantKey;
    const { id: configId } = req.params;
    const data = await runConfigManualJob({ tenantKey, configId });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error queuing tenant manual SAP sync config job', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
};

export const syncTenantConfigSchedule = async (req, reply) => {
  try {
    const tenantKey = req.tenantKey;
    const { id: configId } = req.params;
    const data = await syncSingleConfigSchedule({ tenantKey, configId });
    return reply.code(200).send({ ok: true, data });
  } catch (error) {
    req.log.error({ msg: 'Error syncing tenant config schedule', error });
    return reply.code(400).send({ ok: false, message: error.message });
  }
};
