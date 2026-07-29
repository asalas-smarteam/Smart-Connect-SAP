export class MongooseSyncWarningRepository {
  // Recording a warning must never break a sync run, so every failure path
  // resolves to null instead of throwing.
  async record({
    tenantModels,
    clientConfigId = null,
    syncLogId = null,
    objectType = null,
    sapId = null,
    code = null,
    message = null,
    details = null,
  } = {}) {
    const SyncWarning = tenantModels?.SyncWarning;

    if (typeof SyncWarning?.create !== 'function') {
      return null;
    }

    try {
      return await SyncWarning.create({
        clientConfigId: clientConfigId || undefined,
        syncLogId: syncLogId || undefined,
        objectType,
        sapId,
        code,
        message,
        details,
      });
    } catch (error) {
      console.error('SyncWarning record error:', error);
      return null;
    }
  }
}

export default MongooseSyncWarningRepository;
