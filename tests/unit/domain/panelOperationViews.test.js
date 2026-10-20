import {
  toSyncView,
  EVENT_STATUS_FROM_API,
  SYNC_STATUS_VALUES,
  toEventView,
} from '../../../src/domain/panel/operationViews.js';

describe('operation views for the panel', () => {
  it('maps generic statuses back to the internal ones and never exposes report', () => {
    expect(EVENT_STATUS_FROM_API).toEqual({
      waiting: 'waiting',
      in_process: 'inprocess',
      destination_created: 'sap_order_created',
      destination_created_origin_error: 'sap_created_hubspot_error',
      completed: 'completed',
      errored: 'errored',
    });
    expect(Object.values(EVENT_STATUS_FROM_API)).not.toContain('report');
    expect(SYNC_STATUS_VALUES).toEqual(['completed', 'errored', 'running']);
  });

  it('adds payload and audit only with withRaw', () => {
    const raw = { _id: 'e1', status: 'errored', payload: { deal: { hs_object_id: 1 } }, sapAudit: { a: 1 } };

    expect(toEventView(raw)).not.toHaveProperty('payload');
    expect(toEventView(raw)).not.toHaveProperty('audit');
    expect(toEventView(raw, { withRaw: true })).toEqual(expect.objectContaining({
      payload: { deal: { hs_object_id: 1 } },
      audit: { a: 1 },
    }));
    expect(toEventView({ _id: 'e2', status: 'waiting' }, { withRaw: true }).audit).toBeNull();
  });

  it('shows an unmapped internal status as null instead of hiding the event', () => {
    expect(toEventView({ _id: 'e3', status: 'otro_estado' }).status).toBeNull();
    expect(toEventView({ _id: 'e4', status: 'report' })).toBeNull();
  });

  it('never passes an unknown sync status through and tolerates odd skipped reasons', () => {
    expect(toSyncView({ _id: 's', status: 'killed', skippedReasons: [null, { reason: 'x' }] })).toEqual(expect.objectContaining({
      status: null,
      skippedReasons: [{ reason: 'x', count: 0 }],
    }));
    expect(toSyncView({ _id: 's', status: null }).status).toBe('running');
  });
});
