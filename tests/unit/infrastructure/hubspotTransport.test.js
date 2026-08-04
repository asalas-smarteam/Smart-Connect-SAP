import { jest } from '@jest/globals';
import {
  isIdempotentRequest,
  retryAfterMsFrom,
  sendWithRateLimit,
} from '../../../src/infrastructure/hubspot/hubspotTransport.js';

function axiosStatusError(status, headers = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });
}

function axiosTimeoutError() {
  // What axios throws when `timeout` elapses: no response, so no status.
  return Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
}

function createLimiterSpy() {
  return {
    acquired: [],
    paused: [],
    acquire: jest.fn(async function acquire(endpoint) { this.acquired.push(endpoint); }),
    pauseFor: jest.fn(function pauseFor(endpoint, ms) { this.paused.push({ endpoint, ms }); }),
  };
}

function createOptions(overrides = {}) {
  const limiter = overrides.limiter ?? createLimiterSpy();
  const slept = [];
  return {
    limiter,
    slept,
    options: {
      method: 'post',
      endpoint: '/crm/v3/objects/contacts/search',
      limiter,
      sleeper: async (ms) => { slept.push(ms); },
      random: () => 0.5,
      retries: 3,
      ...overrides,
    },
  };
}

describe('isIdempotentRequest', () => {
  it('treats reads as safe to replay', () => {
    expect(isIdempotentRequest('get', '/crm/v3/objects/contacts')).toBe(true);
    // A search is a POST by protocol but a read by effect.
    expect(isIdempotentRequest('post', '/crm/v3/objects/contacts/search')).toBe(true);
    expect(isIdempotentRequest('post', '/crm/v3/objects/products/batch/read')).toBe(true);
  });

  it('treats updates and associations as safe to replay', () => {
    expect(isIdempotentRequest('patch', '/crm/v3/objects/contacts/123')).toBe(true);
    expect(isIdempotentRequest('post', '/crm/v3/objects/contacts/batch/update')).toBe(true);
    expect(isIdempotentRequest('post', '/crm/v4/associations/company/contact/batch/associate/default')).toBe(true);
  });

  it('treats creates as unsafe to replay', () => {
    // Replaying a create whose outcome is unknown is how duplicates are born.
    expect(isIdempotentRequest('post', '/crm/v3/objects/contacts')).toBe(false);
    expect(isIdempotentRequest('post', '/crm/v3/objects/contacts/batch/create')).toBe(false);
    expect(isIdempotentRequest('post', '/crm/v3/objects/companies/batch/create')).toBe(false);
  });
});

describe('retryAfterMsFrom', () => {
  it('reads the Retry-After header in seconds', () => {
    expect(retryAfterMsFrom(axiosStatusError(429, { 'retry-after': '7' }))).toBe(7000);
  });

  it('returns null when the header is absent or unusable', () => {
    expect(retryAfterMsFrom(axiosStatusError(429))).toBeNull();
    expect(retryAfterMsFrom(axiosStatusError(429, { 'retry-after': 'later' }))).toBeNull();
  });
});

describe('sendWithRateLimit', () => {
  it('acquires a rate-limit slot before every attempt, retries included', async () => {
    const { limiter, options } = createOptions();
    const perform = jest.fn()
      .mockRejectedValueOnce(axiosStatusError(429))
      .mockResolvedValueOnce('ok');

    await expect(sendWithRateLimit(perform, options)).resolves.toBe('ok');

    expect(perform).toHaveBeenCalledTimes(2);
    expect(limiter.acquired).toEqual([options.endpoint, options.endpoint]);
  });

  it('parks the whole policy bucket for the Retry-After window on a 429', async () => {
    const { limiter, options } = createOptions();
    const perform = jest.fn()
      .mockRejectedValueOnce(axiosStatusError(429, { 'retry-after': '5' }))
      .mockResolvedValueOnce('ok');

    await sendWithRateLimit(perform, options);

    expect(limiter.paused).toEqual([{ endpoint: options.endpoint, ms: 5000 }]);
  });

  it('backs off exponentially with jitter when a 429 carries no Retry-After', async () => {
    const { slept, options } = createOptions({ retries: 4 });
    const perform = jest.fn()
      .mockRejectedValueOnce(axiosStatusError(429))
      .mockRejectedValueOnce(axiosStatusError(429))
      .mockResolvedValueOnce('ok');

    await sendWithRateLimit(perform, options);

    // Exponential, not the old flat 1s/2s/3s ladder, and strictly increasing so
    // concurrent workers spread out instead of retrying in lockstep.
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThan(slept[0]);
  });

  it('retries transient server errors', async () => {
    const { options } = createOptions();
    const perform = jest.fn()
      .mockRejectedValueOnce(axiosStatusError(502))
      .mockResolvedValueOnce('ok');

    await expect(sendWithRateLimit(perform, options)).resolves.toBe('ok');
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client error that a replay cannot fix', async () => {
    const { options } = createOptions();
    const perform = jest.fn().mockRejectedValue(axiosStatusError(400));

    await expect(sendWithRateLimit(perform, options)).rejects.toThrow('HTTP 400');
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('replays a timed-out read', async () => {
    const { options } = createOptions({ endpoint: '/crm/v3/objects/contacts/search' });
    const perform = jest.fn()
      .mockRejectedValueOnce(axiosTimeoutError())
      .mockResolvedValueOnce('ok');

    await expect(sendWithRateLimit(perform, options)).resolves.toBe('ok');
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('refuses to replay a timed-out create and flags the outcome as unknown', async () => {
    const { options } = createOptions({ endpoint: '/crm/v3/objects/contacts/batch/create' });
    const perform = jest.fn().mockRejectedValue(axiosTimeoutError());

    // The server may well have created the records; replaying blind is exactly
    // how the duplicate incident happened. Surface it instead so the caller can
    // reconcile against the index.
    await expect(sendWithRateLimit(perform, options)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('still retries a rate-limited create, because a 429 never reached the server', async () => {
    const { options } = createOptions({ endpoint: '/crm/v3/objects/contacts/batch/create' });
    const perform = jest.fn()
      .mockRejectedValueOnce(axiosStatusError(429))
      .mockResolvedValueOnce('ok');

    await expect(sendWithRateLimit(perform, options)).resolves.toBe('ok');
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting its retries and rethrows the last error', async () => {
    const { options } = createOptions({ retries: 2 });
    const perform = jest.fn().mockRejectedValue(axiosStatusError(429));

    await expect(sendWithRateLimit(perform, options)).rejects.toThrow('HTTP 429');
    expect(perform).toHaveBeenCalledTimes(3);
  });
});
