import { jest } from '@jest/globals';

const mockGetTenantModels = jest.fn();
const mockSyncScheduledJob = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/database/tenant/tenantDatabase.js', () => ({
  getTenantModels: mockGetTenantModels,
}));

jest.unstable_mockModule('../../src/infrastructure/scheduler/sapSyncScheduler.service.js', () => ({
  syncScheduledJob: mockSyncScheduledJob,
  bootstrapScheduledJobs: jest.fn(),
  removeTenantScheduledJobs: jest.fn(),
}));

jest.unstable_mockModule('../../src/infrastructure/queue/sapSync.queue.js', () => ({
  addManualSapSyncJob: jest.fn(),
  getSapSyncQueue: jest.fn(),
}));

jest.unstable_mockModule('../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const { setConfigActiveState } = await import(
  '../../src/infrastructure/scheduler/sapSyncQueueAdmin.service.js'
);

function stubConfig(executionTime) {
  return {
    _id: 'cfg-1',
    active: false,
    objectType: 'product',
    mode: 'FULL',
    intervalMinutes: null,
    executionTime,
    executionDays: ['Monday'],
    startTime: null,
    endTime: null,
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('serializeConfig executionTime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncScheduledJob.mockResolvedValue({ action: 'registered' });
  });

  async function activateWith(executionTime) {
    const config = stubConfig(executionTime);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: { findById: jest.fn().mockResolvedValue(config) },
    });

    return setConfigActiveState({ tenantKey: 'printer', configId: 'cfg-1', active: true });
  }

  it('returns an array for a multi-hour config', async () => {
    const result = await activateWith(['07:00', '12:00', '15:00']);

    expect(result.executionTime).toEqual(['07:00', '12:00', '15:00']);
  });

  it('wraps a legacy string value', async () => {
    const result = await activateWith('01:00');

    expect(result.executionTime).toEqual(['01:00']);
  });

  it('returns an empty array when there is no schedule', async () => {
    const result = await activateWith(null);

    expect(result.executionTime).toEqual([]);
  });

  it('echoes back the raw value when it cannot be normalized', async () => {
    const result = await activateWith(['nope']);

    expect(result.executionTime).toEqual(['nope']);
  });
});
