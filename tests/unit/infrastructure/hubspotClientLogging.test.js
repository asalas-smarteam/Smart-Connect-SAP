import { inspect } from 'node:util';
import { jest } from '@jest/globals';

const mockAxios = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: mockLogger,
}));

const { batchCreateObjects } = await import('../../../src/infrastructure/hubspot/hubspotClient.js');

function hubspotError(status, body) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, statusText: 'Conflict', headers: {}, data: body },
  });
}

const CONFLICT_BODY = { category: 'CONFLICT', message: 'Contact already exists' };

describe('hubspotClient request logging', () => {
  beforeEach(() => {
    mockAxios.mockReset();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('logs a status the caller declared expected as a warning, not an error', async () => {
    // A 409 during conflict bisection is a designed step, not a failure: at
    // error level a healthy run reports hundreds of them and looks broken.
    mockAxios.mockRejectedValueOnce(hubspotError(409, CONFLICT_BODY));

    await expect(
      batchCreateObjects('token-1', 'contact', { inputs: [] }, { expectedStatuses: [409] })
    ).rejects.toThrow(/409/);

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatchObject({ status: 409 });
  });

  it('still throws the same wrapped error for an expected status', async () => {
    mockAxios.mockRejectedValueOnce(hubspotError(409, CONFLICT_BODY));

    // Downgrading the log must not downgrade the error: the caller classifies
    // on these details to decide between linking and failing.
    await expect(
      batchCreateObjects('token-1', 'contact', { inputs: [] }, { expectedStatuses: [409] })
    ).rejects.toMatchObject({
      details: { status: 409, hubspotResponse: CONFLICT_BODY },
    });
  });

  it('logs at error level when the status was not declared expected', async () => {
    mockAxios.mockRejectedValueOnce(hubspotError(409, CONFLICT_BODY));

    await expect(batchCreateObjects('token-1', 'contact', { inputs: [] })).rejects.toThrow(/409/);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('logs at error level for a status outside the expected list', async () => {
    mockAxios.mockRejectedValueOnce(hubspotError(400, { category: 'VALIDATION_ERROR' }));

    await expect(
      batchCreateObjects('token-1', 'contact', { inputs: [] }, { expectedStatuses: [409] })
    ).rejects.toThrow(/400/);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('hubspotClient wrapped error cause', () => {
  // What axios attaches to a failed call: the whole request, including the
  // bearer token and the body that was sent.
  function axiosError(status, body) {
    return Object.assign(hubspotError(status, body), {
      code: 'ERR_BAD_REQUEST',
      config: {
        headers: { Authorization: 'Bearer secret-token' },
        data: '{"properties":{"email":"someone@example.com"}}',
      },
      request: { _header: 'Authorization: Bearer secret-token' },
    });
  }

  beforeEach(() => {
    mockAxios.mockReset();
  });

  async function catchWrapped(status, body) {
    mockAxios.mockRejectedValueOnce(axiosError(status, body));
    try {
      await batchCreateObjects('token-1', 'contact', { inputs: [] });
    } catch (error) {
      return error;
    }
    throw new Error('expected batchCreateObjects to reject');
  }

  it('does not carry the token, the request or the sent body', async () => {
    const wrapped = await catchWrapped(400, { category: 'VALIDATION_ERROR' });

    // Callers print the whole error: anything reachable from `cause` ends up
    // in the logs, token and customer data included.
    const printed = JSON.stringify(wrapped.cause) + inspect(wrapped, { depth: 6 });
    expect(printed).not.toContain('secret-token');
    expect(printed).not.toContain('someone@example.com');
    expect(wrapped.cause.config).toBeUndefined();
    expect(wrapped.cause.request).toBeUndefined();
  });

  it('keeps the status and code the callers read from the cause', async () => {
    const wrapped = await catchWrapped(400, { category: 'VALIDATION_ERROR' });

    // hubspotBatchFailure.service and hubspotBatching.utils classify on this.
    expect(wrapped.cause.response.status).toBe(400);
    expect(wrapped.cause.response.data).toEqual({ category: 'VALIDATION_ERROR' });
    expect(wrapped.cause.code).toBe('ERR_BAD_REQUEST');
    expect(wrapped.cause.message).toMatch(/400/);
  });

  it('still preserves the unknown-outcome flag and details', async () => {
    const wrapped = await catchWrapped(400, { category: 'VALIDATION_ERROR' });

    expect(wrapped.details).toMatchObject({ status: 400 });
    expect(wrapped.outcomeUnknown).toBe(false);
  });

  it('flags an unknown outcome for a server error without leaking the request', async () => {
    const wrapped = await catchWrapped(500, { category: 'INTERNAL_ERROR' });

    expect(wrapped.outcomeUnknown).toBe(true);
    expect(wrapped.cause.response.status).toBe(500);
    expect(wrapped.cause.config).toBeUndefined();
  });
});
