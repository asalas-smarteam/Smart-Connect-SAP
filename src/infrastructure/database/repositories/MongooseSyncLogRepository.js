import { finishSyncLog, startSyncLog } from '#infrastructure/sync/syncLog.service.js';

export class MongooseSyncLogRepository {
  async start({
    tenantModels,
    clientConfigId = null,
    objectType = null,
    startedAt = new Date(),
  } = {}) {
    return startSyncLog({
      tenantModels: {
        SyncLog: tenantModels?.SyncLog,
      },
      clientConfigId,
      objectType,
      startedAt,
    });
  }

  async finish(syncLog, payload = {}) {
    return finishSyncLog(syncLog, payload);
  }
}

export default MongooseSyncLogRepository;
