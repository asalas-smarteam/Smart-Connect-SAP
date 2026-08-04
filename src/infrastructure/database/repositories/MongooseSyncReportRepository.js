// Sync data-quality reports live in the WebhookEvents collection: one document
// per run, the whole report in `payload`, discriminated by `eventType`. They are
// written with status `report` so the webhook processor -- which claims on
// `{ status: 'waiting' }` without filtering by eventType -- can never pick one up
// and try to push it to SAP as a deal.
export const SYNC_REPORT_STATUS = 'report';

export class MongooseSyncReportRepository {
  // Recording a report must never break a sync run, so every failure path
  // resolves to null instead of throwing.
  async record({ tenantModels, eventType, payload } = {}) {
    const WebhookEvent = tenantModels?.WebhookEvent;

    if (typeof WebhookEvent?.create !== 'function' || !eventType || !payload) {
      return null;
    }

    try {
      return await WebhookEvent.create({
        eventType,
        payload,
        status: SYNC_REPORT_STATUS,
        retries: 0,
        // A report is never retried; leaving the default 3 would suggest it could
        // be.
        maxRetries: 0,
        lastError: null,
      });
    } catch (error) {
      console.error('Sync report record error:', error);
      return null;
    }
  }
}

export default MongooseSyncReportRepository;
