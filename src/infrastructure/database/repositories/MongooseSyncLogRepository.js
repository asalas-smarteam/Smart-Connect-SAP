import { finishSyncLog, startSyncLog } from '#infrastructure/sync/syncLog.service.js';

function toSyncLogDto(syncLog) {
  if (!syncLog?._id) {
    return null;
  }

  return {
    id: syncLog._id,
    _id: syncLog._id,
    status: syncLog.status ?? null,
  };
}

export class MongooseSyncLogRepository {
  constructor() {
    this.documentsById = new Map();
  }

  async start({
    tenantContext,
    clientConfigId = null,
    objectType = null,
    startedAt = new Date(),
  } = {}) {
    const syncLog = await startSyncLog({
      tenantModels: {
        SyncLog: tenantContext?.tenantModels?.SyncLog,
      },
      clientConfigId,
      objectType,
      startedAt,
    });

    if (syncLog?._id) {
      this.documentsById.set(String(syncLog._id), syncLog);
    }

    return toSyncLogDto(syncLog);
  }

  async finish(syncLog, payload = {}) {
    const id = syncLog?._id ?? syncLog?.id;
    const syncLogDocument = id ? this.documentsById.get(String(id)) : null;

    if (!syncLogDocument) {
      return null;
    }

    return finishSyncLog(syncLogDocument, payload);
  }
}

export default MongooseSyncLogRepository;
