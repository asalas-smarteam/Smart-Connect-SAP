import { jest } from '@jest/globals';
import {
  BATCH_CONCURRENCY,
  HUBSPOT_BATCH_INPUT_LIMIT,
  SEARCH_FALLBACK_CONCURRENCY,
  chunkArray,
  retryRequest,
  runInWaves,
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
});
