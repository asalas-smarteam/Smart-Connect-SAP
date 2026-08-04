// Why a batch failed decides what to do next, and the old code did not ask: any
// error degraded the chunk to the per-item path. That is right for exactly one
// case and catastrophic for another -- a 100-input chunk becomes ~200 individual
// requests, most of them against the scarce Search bucket, at the precise moment
// HubSpot is already throttling the account. Classify first, then react.
export const BATCH_FAILURE = {
  // 400: one bad property rejects all 100 inputs. Per-item isolates the culprit.
  PAYLOAD: 'payload',
  // 409: records exist that our index said did not. A replay cannot fix it.
  CONFLICT: 'conflict',
  // 429: the transport already retried and lost. Amplifying makes it worse.
  RATE_LIMIT: 'rateLimit',
  // Timeout on a create: it may already have been applied. Reconcile, never replay.
  UNKNOWN_OUTCOME: 'unknownOutcome',
  FATAL: 'fatal',
};

function statusOf(error) {
  return error?.details?.status
    ?? error?.response?.status
    ?? error?.cause?.response?.status;
}

export function classifyBatchFailure(error) {
  if (error?.outcomeUnknown === true) {
    return BATCH_FAILURE.UNKNOWN_OUTCOME;
  }

  switch (statusOf(error)) {
    case 400:
      return BATCH_FAILURE.PAYLOAD;
    case 409:
      return BATCH_FAILURE.CONFLICT;
    case 429:
      return BATCH_FAILURE.RATE_LIMIT;
    default:
      return BATCH_FAILURE.FATAL;
  }
}

// HubSpot names the colliding record in the conflict message
// ("Contact already exists. Existing ID: 238524122552"). It is not always
// present on a batch conflict, so callers must handle null.
export function parseConflictExistingId(error) {
  const message = error?.details?.hubspotResponse?.message
    ?? error?.response?.data?.message
    ?? '';
  const match = /Existing ID:\s*(\d+)/i.exec(String(message));

  return match ? match[1] : null;
}

export default classifyBatchFailure;
