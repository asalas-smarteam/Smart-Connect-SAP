import { BUSINESS_DAY_SECONDS, BUSINESS_UTC_OFFSET_MS, businessSeconds } from '../../../src/domain/panel/businessTime.js';

const HOUR = 3600;
// Horas de Costa Rica (UTC−6) escritas con su offset.
const cr = (local) => Date.parse(`${local}-06:00`);
const between = (from, to) => businessSeconds(cr(from), cr(to));

describe('businessSeconds (plan 9, L1: Monday to Friday, 8:00 to 17:00, Costa Rica time)', () => {
  it.each([
    ['mié 09:00 → mié 11:30', '2026-10-28T09:00', '2026-10-28T11:30', 2.5 * HOUR],
    ['mié 06:00 → mié 19:00', '2026-10-28T06:00', '2026-10-28T19:00', 9 * HOUR],
    ['mié 18:00 → mié 22:00', '2026-10-28T18:00', '2026-10-28T22:00', 0],
    ['vie 16:00 → lun 09:00', '2026-10-30T16:00', '2026-11-02T09:00', 2 * HOUR],
    ['sáb 10:00 → lun 10:00', '2026-10-31T10:00', '2026-11-02T10:00', 2 * HOUR],
    ['sáb 08:00 → dom 18:00', '2026-10-31T08:00', '2026-11-01T18:00', 0],
    ['mar 17:30 → mié 08:30', '2026-10-27T17:30', '2026-10-28T08:30', 0.5 * HOUR],
    ['lun 08:00 → vie 17:00', '2026-10-26T08:00', '2026-10-30T17:00', 45 * HOUR],
    ['jue 09:00 → mar 13:00', '2026-10-29T09:00', '2026-11-03T13:00', 31 * HOUR],
    ['vie 09:00 → jue 15:00', '2026-10-02T09:00', '2026-10-08T15:00', 42 * HOUR],
    ['igual', '2026-10-28T10:00', '2026-10-28T10:00', 0],
    ['invertido', '2026-10-28T12:00', '2026-10-28T10:00', 0],
  ])('%s', (label, from, to, expected) => {
    expect(between(from, to)).toBe(expected);
  });

  it('answers 0 for missing or invalid dates', () => {
    expect(businessSeconds(Number.NaN, cr('2026-10-28T10:00'))).toBe(0);
    expect(businessSeconds(cr('2026-10-28T10:00'), Number.NaN)).toBe(0);
    expect(businessSeconds(undefined, undefined)).toBe(0);
  });

  it('uses business days of 9 hours', () => {
    expect(BUSINESS_DAY_SECONDS).toBe(9 * HOUR);
  });

  it('keeps Costa Rica at UTC-6 all year (no daylight saving)', () => {
    const offsetMinutes = (iso) => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Costa_Rica', timeZoneName: 'longOffset' })
        .formatToParts(new Date(iso));
      return parts.find((part) => part.type === 'timeZoneName').value;
    };
    for (const iso of ['2026-01-15T12:00:00Z', '2026-04-15T12:00:00Z', '2026-07-15T12:00:00Z', '2026-10-15T12:00:00Z']) {
      expect(offsetMinutes(iso)).toBe('GMT-06:00');
    }
    expect(BUSINESS_UTC_OFFSET_MS).toBe(-6 * 3_600_000);
  });
});
