import { parseEventFilters, parseSyncFilters } from '../../../../src/application/use-cases/panel/operationFilters.js';

describe('parseEventFilters', () => {
  it('translates the generic status and keeps exact type', () => {
    expect(parseEventFilters({ status: 'destination_created', type: 'createDeal' })).toEqual({
      ok: true,
      filters: { status: 'sap_order_created', type: 'createDeal' },
    });
  });

  it('searches a numeric reference as text and as number', () => {
    expect(parseEventFilters({ reference: '18374652901' }).filters.references).toEqual(['18374652901', 18374652901]);
    expect(parseEventFilters({ reference: 'ABC-1' }).filters.references).toEqual(['ABC-1']);
  });

  it('reads from (inclusive) and to (exclusive) as dates', () => {
    const { filters } = parseEventFilters({ from: '2026-10-05T06:00:00.000Z', to: '2026-10-08T06:00:00.000Z' });
    expect(filters.from.toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(filters.to.toISOString()).toBe('2026-10-08T06:00:00.000Z');
  });

  it.each([
    [{ status: 'report' }, 'Estado inválido.'],
    [{ status: 'inprocess' }, 'Estado inválido.'],
    [{ status: ['errored'] }, 'Estado inválido.'],
    [{ type: ['a', 'b'] }, 'Tipo inválido.'],
    [{ reference: { $ne: null } }, 'Referencia inválida.'],
    [{ from: 'ayer' }, 'Fecha inválida.'],
    [{ to: ['2026-10-01'] }, 'Fecha inválida.'],
  ])('rejects %j', (query, message) => {
    expect(parseEventFilters(query)).toEqual({ ok: false, reason: 'VALIDATION_ERROR', message });
  });
});

describe('parseSyncFilters', () => {
  it('maps running to the internal null status', () => {
    expect(parseSyncFilters({ status: 'running' }).filters).toEqual({ status: null, hasStatus: true });
    expect(parseSyncFilters({ status: 'errored' }).filters).toEqual({ status: 'errored', hasStatus: true });
    expect(parseSyncFilters({}).filters).toEqual({});
  });

  it.each([
    [{ status: 'failed' }, 'Estado inválido.'],
    [{ taskId: 'abc' }, 'Tarea inválida.'],
    [{ taskId: ['6711c0aa00000000000000a1'] }, 'Tarea inválida.'],
    [{ from: '2026-13-45' }, 'Fecha inválida.'],
  ])('rejects %j', (query, message) => {
    expect(parseSyncFilters(query)).toEqual({ ok: false, reason: 'VALIDATION_ERROR', message });
  });
});

describe('parseSyncFilters — plan 5', () => {
  it('maps the event queue task and hideEmpty', () => {
    expect(parseSyncFilters({ taskId: 'event_queue', hideEmpty: 'true' }).filters).toEqual({ eventQueue: true, hideEmpty: true });
    expect(parseSyncFilters({ hideEmpty: 'false' }).filters).toEqual({});
  });

  it.each([[{ hideEmpty: 'yes' }], [{ hideEmpty: ['true'] }]])('rejects %j', (query) => {
    expect(parseSyncFilters(query)).toEqual({ ok: false, reason: 'VALIDATION_ERROR', message: 'Filtro inválido.' });
  });
});
