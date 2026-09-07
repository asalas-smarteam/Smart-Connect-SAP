import {
  EXECUTION_TIME_PATTERN,
  MAX_EXECUTION_TIMES,
  normalizeExecutionTimes,
} from '../../../src/domain/sync/execution-times.js';

describe('normalizeExecutionTimes', () => {
  it('treats empty values as no schedule', () => {
    expect(normalizeExecutionTimes(null)).toEqual([]);
    expect(normalizeExecutionTimes(undefined)).toEqual([]);
    expect(normalizeExecutionTimes('')).toEqual([]);
    expect(normalizeExecutionTimes([])).toEqual([]);
    expect(normalizeExecutionTimes([''])).toEqual([]);
  });

  it('wraps a single string, the shape stored before this change', () => {
    expect(normalizeExecutionTimes('07:00')).toEqual(['07:00']);
  });

  it('trims, deduplicates and sorts ascending', () => {
    expect(normalizeExecutionTimes([' 12:00 ', '07:00', '12:00'])).toEqual(['07:00', '12:00']);
  });

  it('keeps midnight and end-of-day boundaries', () => {
    expect(normalizeExecutionTimes(['23:59', '00:00'])).toEqual(['00:00', '23:59']);
  });

  it('rejects anything that is not zero-padded HH:mm', () => {
    expect(() => normalizeExecutionTimes(['7:00'])).toThrow(/executionTime/);
    expect(() => normalizeExecutionTimes(['24:00'])).toThrow(/executionTime/);
    expect(() => normalizeExecutionTimes(['07:60'])).toThrow(/executionTime/);
    expect(() => normalizeExecutionTimes(['07:00:00'])).toThrow(/executionTime/);
  });

  it('rejects more distinct times than the cap', () => {
    const tooMany = Array.from(
      { length: MAX_EXECUTION_TIMES + 1 },
      (unused, index) => `${String(index).padStart(2, '0')}:0${index % 2}`
    );

    expect(() => normalizeExecutionTimes(tooMany)).toThrow(/executionTime/);
  });

  it('counts distinct times against the cap, not repeated ones', () => {
    const repeated = Array.from({ length: MAX_EXECUTION_TIMES + 5 }, () => '07:00');

    expect(normalizeExecutionTimes(repeated)).toEqual(['07:00']);
  });

  it('exposes the pattern used everywhere else', () => {
    expect(EXECUTION_TIME_PATTERN.test('00:00')).toBe(true);
    expect(EXECUTION_TIME_PATTERN.test('23:59')).toBe(true);
    expect(EXECUTION_TIME_PATTERN.test('24:00')).toBe(false);
  });
});
