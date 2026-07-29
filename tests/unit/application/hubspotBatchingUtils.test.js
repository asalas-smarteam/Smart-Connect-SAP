import { jest } from '@jest/globals';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  SEARCH_FALLBACK_CONCURRENCY,
  chunkArray,
  retryRequest,
  runInWaves,
  summarizeBatchResponse,
  writeChunkSize,
} from '../../../src/application/services/hubspotBatching.utils.js';

describe('hubspotBatching.utils', () => {
  it('exposes the HubSpot batch limits', () => {
    expect(HUBSPOT_BATCH_INPUT_LIMIT).toBe(100);
    expect(BATCH_CONCURRENCY).toBe(4);
    expect(SEARCH_FALLBACK_CONCURRENCY).toBe(2);
  });

  it('chunks arrays preserving order', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 2)).toEqual([]);
  });

  it('runs chunks in waves and collects results in order', async () => {
    const calls = [];
    const results = await runInWaves([1, 2, 3], 2, async (chunk) => {
      calls.push(chunk);
      return chunk * 10;
    });
    expect(results).toEqual([10, 20, 30]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('retries on 429 with linear backoff and rethrows other errors', async () => {
    const sleeper = jest.fn().mockResolvedValue(undefined);
    const rateLimited = Object.assign(new Error('rate'), { response: { status: 429 } });
    const fn = jest.fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce('ok');

    await expect(retryRequest(fn, { sleeper })).resolves.toBe('ok');
    expect(sleeper).toHaveBeenCalledWith(1000);

    const boom = Object.assign(new Error('boom'), { response: { status: 500 } });
    await expect(retryRequest(jest.fn().mockRejectedValue(boom), { sleeper })).rejects.toThrow('boom');
  });

  describe('writeChunkSize', () => {
    it('honors hubspotBatchSize but never exceeds the HubSpot input limit', () => {
      expect(writeChunkSize({ hubspotBatchSize: 25 })).toBe(25);
      expect(writeChunkSize({ hubspotBatchSize: 500 })).toBe(HUBSPOT_BATCH_INPUT_LIMIT);
      expect(writeChunkSize({ hubspotBatchSize: 0 })).toBe(HUBSPOT_BATCH_INPUT_LIMIT);
      expect(writeChunkSize({})).toBe(HUBSPOT_BATCH_INPUT_LIMIT);
      expect(writeChunkSize(null)).toBe(HUBSPOT_BATCH_INPUT_LIMIT);
    });
  });

  describe('summarizeBatchResponse', () => {
    it('counts every input as succeeded on a clean response', () => {
      expect(summarizeBatchResponse({ results: [{ id: '1' }, { id: '2' }] }, 2))
        .toMatchObject({ succeeded: 2, failed: 0, errors: [] });
      // Update endpoints often answer without echoing the inputs back.
      expect(summarizeBatchResponse({ results: [] }, 3)).toMatchObject({ succeeded: 3, failed: 0 });
      expect(summarizeBatchResponse(undefined, 3)).toMatchObject({ succeeded: 3, failed: 0 });
    });

    it('counts only the returned results as succeeded on a 207 partial failure', () => {
      const summary = summarizeBatchResponse(
        { results: [{ id: '1' }], numErrors: 1, errors: [{ message: 'invalid email' }] },
        2
      );

      expect(summary).toMatchObject({ succeeded: 1, failed: 1 });
      expect(summary.results).toHaveLength(1);
      expect(summary.errors).toEqual([{ message: 'invalid email' }]);
    });

    it('never reports more successes than inputs nor negative failures', () => {
      expect(summarizeBatchResponse({ results: [{}, {}, {}] }, 2)).toMatchObject({ succeeded: 2, failed: 0 });
      expect(summarizeBatchResponse({ results: [{}, {}], numErrors: 5 }, 2))
        .toMatchObject({ succeeded: 2, failed: 0 });
    });
  });
});
