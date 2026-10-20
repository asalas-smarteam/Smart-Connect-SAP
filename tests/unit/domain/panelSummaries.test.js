import { addDays, eachLocalDay, localDate, median, mondayOf, parsePeriod } from '../../../src/domain/panel/period.js';
import { integrationSummary } from '../../../src/domain/panel/integrationSummary.js';
import { ticketMetrics } from '../../../src/domain/panel/ticketMetrics.js';

const TZ = 'America/Costa_Rica';
const ms = (iso) => Date.parse(iso);

describe('period (F4)', () => {
  it('parses a valid period and rejects invalid ones', () => {
    expect(parsePeriod({ from: '2026-10-01T06:00:00.000Z', to: '2026-10-08T06:00:00.000Z', tz: TZ })).toEqual({
      from: ms('2026-10-01T06:00:00.000Z'),
      to: ms('2026-10-08T06:00:00.000Z'),
      tz: TZ,
    });
    expect(parsePeriod({ from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z', tz: TZ })).toBeNull();
    expect(parsePeriod({ from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z', tz: TZ })).toBeNull();
    expect(parsePeriod({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', tz: 'Marte/Base' })).toBeNull();
    expect(parsePeriod({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' })).toBeNull();
    expect(parsePeriod({ from: ['2026-10-01'], to: '2026-10-02T00:00:00Z', tz: TZ })).toBeNull();
  });

  it('uses the local day, Monday weeks and medians', () => {
    expect(localDate(ms('2026-10-02T05:59:00Z'), TZ)).toBe('2026-10-01');
    expect(localDate(ms('2026-10-02T06:00:00Z'), TZ)).toBe('2026-10-02');
    expect(eachLocalDay(ms('2026-10-01T06:00:00Z'), ms('2026-10-04T06:00:00Z'), TZ)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(mondayOf('2026-10-04')).toBe('2026-09-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 5])).toBe(3);
  });
});

describe('integrationSummary (F2 to F6)', () => {
  const period = { from: ms('2026-10-05T06:00:00Z'), to: ms('2026-10-08T06:00:00Z'), tz: TZ };
  const ev = (overrides) => ({ createdAt: new Date('2026-10-05T15:00:00Z'), updatedAt: new Date('2026-10-05T15:01:40Z'), ...overrides });
  const events = [
    ev({ status: 'errored', lastError: 'Identificación fiscal incompleta', payload: { deal: { hs_object_id: '1', dealname: 'Renovación' } } }),
    ev({ status: 'completed', createdAt: new Date('2026-10-05T17:00:00Z'), updatedAt: new Date('2026-10-05T17:00:30Z'), payload: { deal: { hs_object_id: 1 } }, sapAudit: { responseSap: { DocNum: 5024831 } } }),
    ev({ status: 'sap_order_created', createdAt: new Date('2026-10-06T10:00:00Z'), updatedAt: new Date('2026-10-06T10:00:10Z'), payload: { deal: { hs_object_id: '2' } } }),
    ev({ status: 'errored', lastError: 'algo raro', createdAt: new Date('2026-10-07T05:00:00Z'), updatedAt: new Date('2026-10-07T05:00:20Z'), payload: { deal: { hs_object_id: '3' } } }),
    ev({ status: 'waiting', createdAt: new Date('2026-10-07T12:00:00Z'), payload: { deal: { hs_object_id: '3' } } }),
    ev({ status: 'report', createdAt: new Date('2026-10-07T12:00:00Z') }),
    ev({ status: 'otro_estado' }),
    ev({ status: 'completed', createdAt: new Date('2026-10-09T00:00:00Z') }),
  ];

  it('builds totals, days, causes, groups and multi-attempt deals', () => {
    const unknown = [];
    const summary = integrationSummary(events, period, { onUnknownStatus: (status) => unknown.push(status) });

    expect(unknown).toEqual(['otro_estado']);
    expect(summary.period).toEqual({ from: '2026-10-05T06:00:00.000Z', to: '2026-10-08T06:00:00.000Z', tz: TZ });
    expect(summary.totals).toEqual({
      documents: 5,
      created: 2,
      errored: 2,
      pending: 1,
      references: 3,
      referencesWithoutDocument: 1,
      avgDurationSeconds: 40,
      avgDurationCreatedSeconds: 20,
      oldestPendingAt: '2026-10-07T12:00:00.000Z',
    });
    expect(summary.byDay).toEqual([
      { date: '2026-10-05', created: 1, errored: 1, pending: 0 },
      { date: '2026-10-06', created: 1, errored: 1, pending: 0 },
      { date: '2026-10-07', created: 0, errored: 0, pending: 1 },
    ]);
    expect(summary.causes).toEqual([
      { key: 'fiscal_id_incomplete', label: 'Identificación fiscal incompleta', group: 'fiscal_data', count: 1 },
      { key: 'other', label: 'Otro error', group: 'other', count: 1 },
    ]);
    expect(summary.groups).toEqual([{ key: 'fiscal_data', count: 1 }, { key: 'other', count: 1 }]);
    expect(summary.multiAttempt.total).toBe(2);
    expect(summary.multiAttempt.items[0]).toEqual({
      reference: '3',
      title: null,
      attempts: 2,
      resolvedAfterSeconds: null,
      steps: [
        { at: '2026-10-07T05:00:00.000Z', status: 'errored', summary: 'Otro error', documentNumber: null },
        { at: '2026-10-07T12:00:00.000Z', status: 'waiting', summary: 'En proceso', documentNumber: null },
      ],
    });
    expect(summary.multiAttempt.items[1]).toEqual(expect.objectContaining({
      reference: '1',
      title: 'Renovación',
      resolvedAfterSeconds: 7230,
      steps: [
        expect.objectContaining({ status: 'errored', summary: 'Identificación fiscal incompleta' }),
        expect.objectContaining({ status: 'completed', summary: 'Documento creado', documentNumber: '5024831' }),
      ],
    }));
  });

  it('returns empty days with zeros and null averages without data', () => {
    const summary = integrationSummary([], period);
    expect(summary.byDay).toHaveLength(3);
    expect(summary.totals.avgDurationSeconds).toBeNull();
    expect(summary.totals.oldestPendingAt).toBeNull();
    expect(summary.causes).toEqual([]);
  });
});

describe('ticketMetrics (F8, F9)', () => {
  const period = { from: ms('2026-09-28T06:00:00Z'), to: ms('2026-10-12T06:00:00Z'), tz: TZ };
  const t = (overrides) => ({ status: 'resuelto', category: 'documentos', reopenCount: 0, firstResponseAt: null, resolvedAt: null, ...overrides });
  const tickets = [
    t({ openedAt: new Date('2026-09-29T14:00:00Z'), firstResponseAt: new Date('2026-09-29T15:00:00Z'), resolvedAt: new Date('2026-09-29T16:00:00Z') }),
    t({ openedAt: new Date('2026-10-01T14:00:00Z'), firstResponseAt: new Date('2026-10-01T17:00:00Z'), resolvedAt: new Date('2026-10-03T14:00:00Z'), reopenCount: 1, category: 'precios' }),
    t({ status: 'en_progreso', openedAt: new Date('2026-10-05T14:00:00Z'), firstResponseAt: new Date('2026-10-05T14:30:00Z'), resolvedAt: new Date('2026-10-06T14:00:00Z'), reopenCount: 1 }),
    t({ status: 'abierto', openedAt: new Date('2026-10-10T14:00:00Z') }),
    t({ openedAt: new Date('2026-09-20T14:00:00Z'), resolvedAt: new Date('2026-09-20T15:00:00Z') }),
  ];

  it('computes totals, weeks, buckets and categories', () => {
    const body = ticketMetrics(tickets, period);

    expect(body.totals).toEqual({
      resolved: 2,
      resolvedPreviousPeriod: 1,
      reopened: 1,
      open: 2,
      openWithoutFirstResponse: 1,
      medianFirstResponseSeconds: 3600,
      medianResolutionSeconds: 90000,
    });
    expect(body.byWeek).toEqual([
      { weekStart: '2026-09-28', resolved: 2, reopened: 1, medianResolutionSeconds: 90000 },
      { weekStart: '2026-10-05', resolved: 0, reopened: 0, medianResolutionSeconds: null },
    ]);
    expect(body.buckets).toEqual([
      { key: 'lt4h', count: 1 },
      { key: '4h_24h', count: 0 },
      { key: '1d_3d', count: 1 },
      { key: 'gt3d', count: 0 },
    ]);
    expect(body.byCategory).toEqual([
      { category: 'documentos', resolved: 1, medianResolutionSeconds: 7200 },
      { category: 'precios', resolved: 1, medianResolutionSeconds: 172800 },
    ]);
    expect(body).not.toHaveProperty('byTenant');
  });

  it('adds byTenant only when tenants are given, by resolved desc', () => {
    const body = ticketMetrics(tickets, period, {
      tenants: [
        { tenantKey: 'b', companyName: 'Beta', tickets: tickets.slice(3) },
        { tenantKey: 'a', companyName: 'Alfa', tickets: tickets.slice(0, 3) },
      ],
    });

    expect(body.byTenant.map((row) => [row.tenantKey, row.resolved, row.open])).toEqual([['a', 2, 1], ['b', 0, 1]]);
  });
});
