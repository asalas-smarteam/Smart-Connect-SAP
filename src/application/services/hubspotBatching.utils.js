// HubSpot batch endpoints (read/create/update) accept at most 100 inputs per call.
export const HUBSPOT_BATCH_INPUT_LIMIT = 100;
// Concurrent batch calls per wave. 4 keeps us well under HubSpot's ~190 requests/10s limit.
export const BATCH_CONCURRENCY = 4;
// The Search API is limited to ~4 requests/second, so its fallback waves are narrower.
export const SEARCH_FALLBACK_CONCURRENCY = 2;

export function chunkArray(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

export async function runInWaves(chunks, concurrency, worker) {
  const results = [];
  for (const wave of chunkArray(chunks, concurrency)) {
    results.push(...await Promise.all(wave.map(worker)));
  }
  return results;
}

const defaultSleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryRequest(fn, { retries = 5, sleeper = defaultSleeper } = {}) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.response?.status ?? err?.details?.status ?? err?.cause?.response?.status;

    if (status === 429 && retries > 0) {
      const delay = 1000 * (6 - retries);
      await sleeper(delay);
      return retryRequest(fn, { retries: retries - 1, sleeper });
    }

    throw err;
  }
}
