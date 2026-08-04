import {
  HUBSPOT_POLICY,
  HubspotRateLimiter,
  policyForEndpoint,
} from '../../../src/infrastructure/hubspot/hubspotRateLimiter.js';

// Virtual clock: sleeper advances time instead of waiting, so the tests assert
// on elapsed time (the real observable) without taking that long to run.
function createClock() {
  let now = 0;
  return {
    now: () => now,
    sleeper: async (ms) => { now += Math.max(ms, 0); },
  };
}

function createLimiter(clock, rates = { search: 4, general: 15 }) {
  return new HubspotRateLimiter({ rates, now: clock.now, sleeper: clock.sleeper });
}

const SEARCH = '/crm/v3/objects/contacts/search';
const CREATE = '/crm/v3/objects/contacts/batch/create';

describe('policyForEndpoint', () => {
  it('routes search endpoints to their own policy group', () => {
    // HubSpot meters search under publicapi:crm:search, separate from the
    // general bucket, at a far lower rate.
    expect(policyForEndpoint(SEARCH)).toBe(HUBSPOT_POLICY.SEARCH);
    expect(policyForEndpoint('/crm/v3/objects/companies/search')).toBe(HUBSPOT_POLICY.SEARCH);
  });

  it('routes every other endpoint to the general policy group', () => {
    expect(policyForEndpoint(CREATE)).toBe(HUBSPOT_POLICY.GENERAL);
    expect(policyForEndpoint('/crm/v3/objects/contacts')).toBe(HUBSPOT_POLICY.GENERAL);
    expect(policyForEndpoint('/crm/v3/properties/contacts')).toBe(HUBSPOT_POLICY.GENERAL);
  });
});

describe('HubspotRateLimiter', () => {
  it('lets a full burst through without waiting', async () => {
    const clock = createClock();
    const limiter = createLimiter(clock);

    for (let call = 0; call < 4; call += 1) {
      await limiter.acquire(SEARCH);
    }

    expect(clock.now()).toBe(0);
  });

  it('makes the call past the burst wait for a token to refill', async () => {
    const clock = createClock();
    const limiter = createLimiter(clock);

    for (let call = 0; call < 4; call += 1) {
      await limiter.acquire(SEARCH);
    }
    await limiter.acquire(SEARCH);

    // 4 tokens/second means the 5th call cannot leave before t=250ms.
    expect(clock.now()).toBeGreaterThanOrEqual(250);
  });

  it('caps a long run of search calls at the configured rate', async () => {
    const clock = createClock();
    const limiter = createLimiter(clock);

    for (let call = 0; call < 24; call += 1) {
      await limiter.acquire(SEARCH);
    }

    // 24 calls at 4/s with a burst of 4 cannot finish before 5s.
    expect(clock.now()).toBeGreaterThanOrEqual(5000);
  });

  it('does not let a saturated search bucket delay general calls', async () => {
    const clock = createClock();
    const limiter = createLimiter(clock);

    for (let call = 0; call < 8; call += 1) {
      await limiter.acquire(SEARCH);
    }
    const saturatedAt = clock.now();
    await limiter.acquire(CREATE);

    expect(clock.now()).toBe(saturatedAt);
  });

  it('holds back the whole bucket for the Retry-After window, not just one caller', async () => {
    const clock = createClock();
    const limiter = createLimiter(clock);

    // One 429 means the account is over its limit: every other in-flight worker
    // has to back off too, or they each burn their own 429 discovering it.
    limiter.pauseFor(SEARCH, 3000);
    await limiter.acquire(SEARCH);

    expect(clock.now()).toBeGreaterThanOrEqual(3000);
  });

  it('keeps a Retry-After pause scoped to the offending policy group', async () => {
    const clock = createClock();
    const limiter = createLimiter(clock);

    limiter.pauseFor(SEARCH, 3000);
    await limiter.acquire(CREATE);

    expect(clock.now()).toBe(0);
  });
});
