import { runSapSyncOnce } from '../tasks/sapSyncTask.js';
import { runWebhookProcessorOnce } from '../tasks/webhookProcessorTask.js';

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
    await runWebhookProcessorOnce();
    reply.code(200).send({ message: 'SAP sync jobs executed successfully' });
  } catch (error) {
    req.log.error({ msg: 'Error executing SAP sync jobs manually', error });
    reply.code(500).send({ message: 'Failed to execute SAP sync jobs', error: error.message });
  }
}
