import { jest } from '@jest/globals';
import {
  BATCH_FAILURE,
  classifyBatchFailure,
  parseConflictExistingId,
} from '../../../src/application/services/hubspotBatchFailure.service.js';
import { createWithConflictSplit } from '../../../src/application/services/hubspotBatching.utils.js';

// Shaped like what hubspotClient throws after wrapping an axios failure.
function wrappedError(status, hubspotResponse = {}, extra = {}) {
  return Object.assign(new Error(`HubSpot API request failed: ${status}`), {
    details: { status, hubspotResponse },
    ...extra,
  });
}

describe('classifyBatchFailure', () => {
  it('marks a payload rejection as the only case worth isolating per item', () => {
    // One unknown property makes HubSpot reject all 100 inputs; going per item
    // is what finds the single bad record.
    expect(classifyBatchFailure(wrappedError(400, { category: 'VALIDATION_ERROR' })))
      .toBe(BATCH_FAILURE.PAYLOAD);
  });

  it('marks a conflict distinctly, because a replay cannot fix it', () => {
    expect(classifyBatchFailure(wrappedError(409, { category: 'CONFLICT' })))
      .toBe(BATCH_FAILURE.CONFLICT);
  });

  it('marks rate limiting distinctly, because the transport already retried it', () => {
    expect(classifyBatchFailure(wrappedError(429, { errorType: 'RATE_LIMIT' })))
      .toBe(BATCH_FAILURE.RATE_LIMIT);
  });

  it('marks an unknown outcome distinctly, because it may already have been applied', () => {
    expect(classifyBatchFailure(wrappedError(undefined, {}, { outcomeUnknown: true })))
      .toBe(BATCH_FAILURE.UNKNOWN_OUTCOME);
  });

  it('falls back to fatal for anything else', () => {
    expect(classifyBatchFailure(wrappedError(403))).toBe(BATCH_FAILURE.FATAL);
    expect(classifyBatchFailure(new Error('boom'))).toBe(BATCH_FAILURE.FATAL);
  });
});

describe('parseConflictExistingId', () => {
  it('extracts the id HubSpot names in a conflict message', () => {
    expect(parseConflictExistingId(wrappedError(409, {
      message: 'Contact already exists. Existing ID: 238524122552',
    }))).toBe('238524122552');
  });

  it('returns null when the conflict names no id', () => {
    // Observed in production: a batch conflict often omits it.
    expect(parseConflictExistingId(wrappedError(409, { message: 'Contact already exists' })))
      .toBeNull();
  });
});

describe('createWithConflictSplit', () => {
  const conflict = (existingId) => wrappedError(409, {
    category: 'CONFLICT',
    message: existingId ? `Contact already exists. Existing ID: ${existingId}` : 'Contact already exists',
  });

  it('sends a clean batch exactly once', async () => {
    const send = jest.fn().mockResolvedValue({ results: [{ id: '1' }, { id: '2' }] });

    const outcome = await createWithConflictSplit(['a', 'b'], { send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.responses).toEqual([{ results: [{ id: '1' }, { id: '2' }] }]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });

  it('isolates the conflicting entry by halving, and still creates the rest', async () => {
    // ['a','b'] conflicts as a batch; 'a' alone conflicts, 'b' alone is fine.
    const send = jest.fn(async (entries) => {
      if (entries.includes('a')) throw conflict('999');
      return { results: entries.map((entry) => ({ id: entry })) };
    });

    const outcome = await createWithConflictSplit(['a', 'b'], { send });

    expect(outcome.conflicts).toEqual([{ entry: 'a', existingId: '999' }]);
    expect(outcome.responses).toEqual([{ results: [{ id: 'b' }] }]);
    expect(outcome.failed).toEqual([]);
  });

  it('resolves a conflict inside a large chunk logarithmically, never per item', async () => {
    const entries = Array.from({ length: 64 }, (_, index) => `entry-${index}`);
    const send = jest.fn(async (chunk) => {
      if (chunk.includes('entry-42')) throw conflict('123');
      return { results: chunk.map((entry) => ({ id: entry })) };
    });

    const outcome = await createWithConflictSplit(entries, { send });

    expect(outcome.conflicts).toEqual([{ entry: 'entry-42', existingId: '123' }]);
    // Bisecting 64 entries costs ~2*log2(64) calls. The per-item path this
    // replaces would have cost 64 searches plus 64 creates.
    expect(send.mock.calls.length).toBeLessThan(20);
    // Every non-conflicting entry was still created.
    const created = outcome.responses.flatMap((response) => response.results.map((item) => item.id));
    expect(created).toHaveLength(63);
    expect(created).not.toContain('entry-42');
  });

  it('reports a conflict with no id rather than inventing one', async () => {
    const send = jest.fn(async () => { throw conflict(null); });

    const outcome = await createWithConflictSplit(['only'], { send });

    expect(outcome.conflicts).toEqual([{ entry: 'only', existingId: null }]);
  });

  it('never splits a rate-limited batch, so a 429 cannot amplify into many calls', async () => {
    const send = jest.fn(async () => { throw wrappedError(429, { errorType: 'RATE_LIMIT' }); });

    const outcome = await createWithConflictSplit(['a', 'b', 'c', 'd'], { send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].entries).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never splits a payload rejection, leaving it to the per-item path', async () => {
    const send = jest.fn(async () => { throw wrappedError(400, { category: 'VALIDATION_ERROR' }); });

    const outcome = await createWithConflictSplit(['a', 'b'], { send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.failed[0].failure).toBe(BATCH_FAILURE.PAYLOAD);
  });
});
