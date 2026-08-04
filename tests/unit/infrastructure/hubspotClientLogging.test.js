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
