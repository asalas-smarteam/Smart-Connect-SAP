import { runSapSyncOnce } from '../tasks/sapSyncTask.js';

export async function triggerSapSync(req, reply) {
  try {
    await runSapSyncOnce();
    reply.code(200).send({ message: 'SAP sync jobs executed successfully' });
  } catch (error) {
    req.log.error({ msg: 'Error executing SAP sync jobs manually', error });
    reply.code(500).send({ message: 'Failed to execute SAP sync jobs', error: error.message });
  }
}
