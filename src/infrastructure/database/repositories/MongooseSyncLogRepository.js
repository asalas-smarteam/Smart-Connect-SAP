import { finishSyncLog, startSyncLog } from '../../../services/syncLog.service.js';

export class MongooseSyncLogRepository {
  async start({ tenantModels, clientConfigId = null, startedAt = new Date() } = {}) {
    return startSyncLog({
      tenantModels: {
        SyncLog: tenantModels?.SyncLog,
      },
      clientConfigId,
      startedAt,
    });
  }

  async finish(syncLog, payload = {}) {
    return finishSyncLog(syncLog, payload);
  }
}

export default MongooseSyncLogRepository;

