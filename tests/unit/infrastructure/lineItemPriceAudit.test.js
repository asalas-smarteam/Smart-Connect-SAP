import { buildLineItemPriceAudit } from '../../../src/infrastructure/sync/syncLog.service.js';
import { createSapCallRecorder } from '../../../src/infrastructure/sap/sapCallRecorder.js';

describe('buildLineItemPriceAudit', () => {
  it('prefixes $-leading keys and drops @odata keys of a failed call', () => {
    const error = Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
      details: { endpoint: '/crm/v3/objects/line_items/58061514894', status: 404 },
    });

    const audit = buildLineItemPriceAudit({
      dealId: '64058987777',
      calls: [{
        target: 'sap',
        method: 'get',
        path: "/b1s/v2/Items('A0001')",
        params: { $select: 'ItemPrices', $top: 1 },
        ok: false,
        status: 404,
        request: { '$set': 1, '@odata.context': 'x', ItemCode: 'A0001' },
        error,
      }],
    });

    expect(audit.calls[0].params).toBe('$select=ItemPrices&$top=1');
    expect(audit.calls[0].request).toEqual({ _$set: 1, ItemCode: 'A0001' });
    expect(audit.calls[0].error.status).toBe(404);
    expect(audit.calls[0].method).toBe('GET');
    expect(audit.dealId).toBe('64058987777');
  });

  it('keeps successful calls compact: no request or response body', () => {
    const audit = buildLineItemPriceAudit({
      calls: [{
        target: 'hubspot',
        method: 'POST',
        path: '/crm/v3/objects/line_items/batch/update',
        ok: true,
        durationMs: 120,
        request: { inputs: [{ id: '1' }] },
        response: { results: [{ id: '1' }] },
      }],
    });

    expect(audit.calls[0]).toEqual({
      target: 'hubspot',
      method: 'POST',
      path: '/crm/v3/objects/line_items/batch/update',
      params: null,
      ok: true,
      status: null,
      durationMs: 120,
    });
  });

  it('caps the number of recorded calls and reports how many were dropped', () => {
    const calls = Array.from({ length: 205 }, (_unused, index) => ({
      target: 'sap', method: 'GET', path: `/p/${index}`, ok: true,
    }));

    const audit = buildLineItemPriceAudit({ calls });

    expect(audit.calls).toHaveLength(200);
    expect(audit.droppedCalls).toBe(5);
  });

  // El test de arriba le pasa 205 llamadas sintéticas DIRECTO al constructor, así que pasa en
  // verde aunque el grabador real nunca llegue a 200. Éste recorre la costura completa: es el
  // grabador el que descarta, y su cuenta tiene que aparecer en el audit.
  it('reports the calls that the real recorder itself dropped', async () => {
    const recorder = createSapCallRecorder({ maxCalls: 200 });

    for (let index = 0; index < 205; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await recorder.record({ target: 'sap', method: 'GET', path: `/p/${index}` }, async () => ({}));
    }

    expect(recorder.calls).toHaveLength(200);
    expect(recorder.droppedCalls).toBe(5);

    const audit = buildLineItemPriceAudit({
      calls: recorder.calls,
      droppedCalls: recorder.droppedCalls,
    });

    expect(audit.calls).toHaveLength(200);
    expect(audit.droppedCalls).toBe(5);
  });

  it('adds the calls dropped by the recorder to the ones it truncates itself', () => {
    const calls = Array.from({ length: 205 }, (_unused, index) => ({
      target: 'sap', method: 'GET', path: `/p/${index}`, ok: true,
    }));

    const audit = buildLineItemPriceAudit({ calls, droppedCalls: 3 });

    expect(audit.droppedCalls).toBe(8);
  });

  it('returns null instead of throwing when the trail cannot be read', () => {
    const trail = { get rounds() { throw new Error('boom'); } };

    expect(buildLineItemPriceAudit(trail)).toBeNull();
  });

  it('defaults every section when the trail is empty', () => {
    const audit = buildLineItemPriceAudit(null);

    expect(audit.rounds).toEqual([]);
    expect(audit.calls).toEqual([]);
    expect(audit.unresolved).toEqual([]);
    expect(audit.amount).toBeNull();
    expect(audit.fatalError).toBeNull();
    expect(typeof audit.capturedAt).toBe('string');
  });
});
