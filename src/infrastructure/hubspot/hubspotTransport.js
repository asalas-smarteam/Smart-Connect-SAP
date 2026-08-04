// Rate limiting and retry belong here, wrapped around the single function every
// HubSpot call already flows through, for two reasons the previous design paid
// for: a limit that is enforced per call site gets forgotten at the call site
// that needs it most (the per-item path had no retry at all), and N independent
// retry/concurrency pools hand out N budgets for one account-wide limit.
import { hubspotRateLimiter } from './hubspotRateLimiter.js';

export const DEFAULT_RETRIES = 5;
const BASE_BACKOFF_MS = 500;

// A POST that only reads, and a POST that can be replayed to the same end state.
const READ_LIKE_POST = /\/(search|batch\/read)\/?$/;
const REPLAYABLE_POST = /\/batch\/(update|archive|associate\/default)\/?$/;

// Whether replaying this request is safe when its outcome is UNKNOWN. Only
// creates are unsafe: replaying one that already succeeded server-side is
// precisely how a timeout turns into a duplicate record.
export function isIdempotentRequest(method, endpoint) {
  if (String(method ?? '').toLowerCase() !== 'post') {
    return true;
  }

  const path = String(endpoint ?? '');

  return READ_LIKE_POST.test(path) || REPLAYABLE_POST.test(path);
}

export function retryAfterMsFrom(error) {
  const headers = error?.response?.headers ?? {};
  const raw = headers['retry-after'] ?? headers['Retry-After'];

  if (raw === undefined || raw === null) {
    return null;
  }

  const seconds = Number(raw);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

// Exponential with jitter. The jitter is the point: the old fixed ladder made
// every concurrent worker retry at the same instants, so they rediscovered the
// same 429 together instead of draining.
function backoffMs(attempt, random) {
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);

  return Math.round(exponential * (0.5 + 0.5 * random()));
}

const defaultSleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendWithRateLimit(perform, {
  method,
  endpoint,
  limiter = hubspotRateLimiter,
  sleeper = defaultSleeper,
  random = Math.random,
  retries = DEFAULT_RETRIES,
} = {}) {
  const replayable = isIdempotentRequest(method, endpoint);
  let attempt = 0;

  for (;;) {
    await limiter.acquire(endpoint);

    try {
      return await perform();
    } catch (error) {
      const status = error?.response?.status;

      if (status === 429) {
        // Rate limiting is the one failure that is always safe to replay: the
        // request was rejected, so it had no effect -- creates included.
        const retryAfter = retryAfterMsFrom(error);

        if (retryAfter !== null) {
          limiter.pauseFor(endpoint, retryAfter);
        }

        if (attempt >= retries) {
          throw error;
        }

        attempt += 1;

        if (retryAfter === null) {
          await sleeper(backoffMs(attempt, random));
        }

        continue;
      }

      const serverError = Number.isFinite(status) && status >= 500 && status < 600;
      const noResponse = !error?.response;

      if (serverError || noResponse) {
        if (!replayable) {
          // Outcome genuinely unknown: it may have been applied. Say so instead
          // of guessing, so the caller can reconcile against what HubSpot holds.
          error.outcomeUnknown = true;
          throw error;
        }

        if (attempt >= retries) {
          throw error;
        }

        attempt += 1;
        await sleeper(backoffMs(attempt, random));
        continue;
      }

      throw error;
    }
  }
}

export default sendWithRateLimit;
