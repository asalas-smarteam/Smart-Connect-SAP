import {
  BATCH_FAILURE,
  classifyBatchFailure,
  parseConflictExistingId,
} from './hubspotBatchFailure.service.js';

// HubSpot batch endpoints (read/create/update) accept at most 100 inputs per call.
export const HUBSPOT_BATCH_INPUT_LIMIT = 100;
// Concurrent batch calls per wave. 4 keeps us well under HubSpot's ~190 requests/10s limit.
export const BATCH_CONCURRENCY = 4;

// Per-run write chunk size: honors the tenant's hubspotBatchSize, never above
// HubSpot's hard 100-input limit. Read chunks always use the full limit.
export function writeChunkSize(clientConfig) {
  return Math.min(
    Number(clientConfig?.hubspotBatchSize) || HUBSPOT_BATCH_INPUT_LIMIT,
    HUBSPOT_BATCH_INPUT_LIMIT
  );
}

// HubSpot batch endpoints answer 207 on a PARTIAL failure: `results` holds only
// the inputs that succeeded and `numErrors`/`errors` describe the rest. Reading
// `results` alone counts a partial batch as a full success, so every batch call
// site runs its response through this.
export function summarizeBatchResponse(response, inputCount) {
  const results = Array.isArray(response?.results) ? response.results : [];
  const numErrors = Number(response?.numErrors) || 0;
  const errors = Array.isArray(response?.errors) ? response.errors : [];
  // On a clean 200 many clients answer without echoing the inputs back, so an
  // empty `results` with no errors still means "all inputs went through".
  const succeeded = numErrors > 0
    ? Math.min(results.length, inputCount)
    : Math.min(Math.max(results.length, inputCount - numErrors), inputCount);

  return { results, errors, succeeded, failed: Math.max(inputCount - succeeded, 0) };
}

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

// A batch conflict rejects the WHOLE chunk and names at most one existing id,
// without saying which input it belonged to -- so the colliding record cannot be
// mapped from the response. Halving finds it in ~2*log2(n) calls against the
// general bucket, instead of the ~2n calls (half of them Search) that the
// per-item fallback used to spend, and every innocent record still gets created.
// Only conflicts split: any other failure is returned as-is, never amplified.
export async function createWithConflictSplit(entries, { send }) {
  const responses = [];
  const conflicts = [];
  const failed = [];
  const pending = [entries];

  while (pending.length > 0) {
    const chunk = pending.shift();

    if (chunk.length === 0) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      responses.push(await send(chunk));
    } catch (error) {
      const failure = classifyBatchFailure(error);

      if (failure !== BATCH_FAILURE.CONFLICT) {
        failed.push({ entries: chunk, error, failure });
        continue;
      }

      if (chunk.length === 1) {
        // Narrowed to one record, so the id in the message is unambiguous.
        conflicts.push({ entry: chunk[0], existingId: parseConflictExistingId(error) });
        continue;
      }

      const middle = Math.floor(chunk.length / 2);
      pending.push(chunk.slice(0, middle), chunk.slice(middle));
    }
  }

  return { responses, conflicts, failed };
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
