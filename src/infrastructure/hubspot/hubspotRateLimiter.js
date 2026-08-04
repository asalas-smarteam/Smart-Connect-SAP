// HubSpot meters requests in independent policy groups, and the one that bites
// hardest is not the general limit everybody quotes. Search lives in its own
// group (`publicapi:crm:search:...`) capped at 5 requests/second ACCOUNT-wide;
// the general group allows ~190/10s. Bounding concurrency is not the same as
// bounding rate: four workers each looping sequentially over ~200ms calls issue
// ~20 requests/second, four times over the search limit. So the rate has to be
// enforced here, at the one chokepoint every HubSpot call already passes
// through, rather than per call site where it can be (and was) forgotten.

export const HUBSPOT_POLICY = {
  SEARCH: 'search',
  GENERAL: 'general',
};

// Deliberately under the documented ceilings: HubSpot counts per account, and
// other processes (webhooks, a second worker, a colleague's manual run) share
// the same budget. Leaving headroom is what keeps a burst from becoming a 429.
export const DEFAULT_POLICY_RATES = {
  [HUBSPOT_POLICY.SEARCH]: Number(process.env.HUBSPOT_SEARCH_RATE_PER_SECOND) || 4,
  [HUBSPOT_POLICY.GENERAL]: Number(process.env.HUBSPOT_GENERAL_RATE_PER_SECOND) || 15,
};

export function policyForEndpoint(endpoint) {
  return /\/search\/?$/.test(String(endpoint ?? ''))
    ? HUBSPOT_POLICY.SEARCH
    : HUBSPOT_POLICY.GENERAL;
}

const defaultSleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One bucket per policy group. Slots are reserved by advancing `nextSlotAt`
// SYNCHRONOUSLY before any await, so two concurrent callers can never be handed
// the same slot -- a token counter that sleeps first and decrements after would
// let exactly that happen, which is the race that produces bursts.
class PolicyBucket {
  constructor({ ratePerSecond, now, sleeper }) {
    this.interval = 1000 / Math.max(ratePerSecond, 0.001);
    this.burst = Math.max(Math.floor(ratePerSecond), 1);
    this.now = now;
    this.sleeper = sleeper;
    this.nextSlotAt = -Infinity;
    this.pausedUntil = -Infinity;
  }

  // A 429 is account-wide news, not this caller's private problem: parking the
  // whole bucket stops the other in-flight workers from each spending their own
  // 429 to learn the same thing.
  pauseFor(ms) {
    const until = this.now() + Math.max(ms, 0);

    if (until > this.pausedUntil) {
      this.pausedUntil = until;
    }
  }

  async acquire() {
    if (this.pausedUntil > this.now()) {
      await this.sleeper(this.pausedUntil - this.now());
    }

    const now = this.now();
    // Idle time earns burst credit, but only up to `burst` slots -- otherwise a
    // long-idle bucket would release an unbounded flood on the next batch.
    const floor = now - (this.burst - 1) * this.interval;

    if (this.nextSlotAt < floor) {
      this.nextSlotAt = floor;
    }

    const slot = this.nextSlotAt;
    this.nextSlotAt = slot + this.interval;

    if (slot > now) {
      await this.sleeper(slot - now);
    }

    return slot;
  }
}

export class HubspotRateLimiter {
  constructor({ rates = DEFAULT_POLICY_RATES, now = () => Date.now(), sleeper = defaultSleeper } = {}) {
    this.buckets = new Map(
      Object.values(HUBSPOT_POLICY).map((policy) => [
        policy,
        new PolicyBucket({
          ratePerSecond: rates[policy] ?? DEFAULT_POLICY_RATES[policy],
          now,
          sleeper,
        }),
      ])
    );
  }

  bucketFor(endpoint) {
    return this.buckets.get(policyForEndpoint(endpoint));
  }

  async acquire(endpoint) {
    return this.bucketFor(endpoint).acquire();
  }

  pauseFor(endpoint, ms) {
    this.bucketFor(endpoint).pauseFor(ms);
  }
}

// Process-wide instance: the limit is per HubSpot account, so a per-call-site or
// per-use-case limiter would hand out N independent budgets for one real one.
export const hubspotRateLimiter = new HubspotRateLimiter();

export default hubspotRateLimiter;
