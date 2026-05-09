import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
  finishSyncLog,
  startSyncLog,
} from './syncLog.service.js';

export class SyncLogAdapter {
  start(input) {
    return startSyncLog(input);
  }

  finish(syncLog, payload) {
    return finishSyncLog(syncLog, payload);
  }

  buildErrorResponseSnapshot(error) {
    return buildErrorResponseSnapshot(error);
  }

  buildWebhookSyncErrorEntry(entry) {
    return buildWebhookSyncErrorEntry(entry);
  }
}

export const syncLogAdapter = new SyncLogAdapter();

export default syncLogAdapter;
