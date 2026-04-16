import crypto from 'crypto';
import { jest } from '@jest/globals';

const mockAddScheduledSapSyncJob = jest.fn();
const mockGetSapSyncQueue = jest.fn();
const mockListActiveTenants = jest.fn();
const mockGetTenantModels = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule('../../src/queues/sapSync.queue.js', () => ({
  SAP_SYNC_JOB_NAME: 'sap-sync-job',
  addScheduledSapSyncJob: mockAddScheduledSapSyncJob,
  buildScheduledJobId: ({ tenantKey, configId }) => `sap-sync:${tenantKey}:${String(configId)}`,
  getSapSyncQueue: mockGetSapSyncQueue,
}));

jest.unstable_mockModule('../../src/utils/tenantSubscriptions.js', () => ({
  listActiveTenants: mockListActiveTenants,
}));

jest.unstable_mockModule('../../src/config/tenantDatabase.js', () => ({
  getTenantModels: mockGetTenantModels,
}));

jest.unstable_mockModule('../../src/core/logger.js', () => ({
  default: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

const {
  bootstrapScheduledJobs,
  syncScheduledJob,
} = await import('../../src/services/scheduler/sapSyncScheduler.service.js');

function buildLegacyRepeatableKey({ jobId, suffix, timezone = '' }) {
  return crypto
    .createHash('md5')
    .update(`sap-sync-job:${jobId}::${timezone}:${suffix}`)
    .digest('hex');
}

describe('sapSyncScheduler.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListActiveTenants.mockResolvedValue([]);
    mockGetTenantModels.mockResolvedValue({});
  });

  it('replaces the previous FULL schedule and applies America/Costa_Rica timezone', async () => {
    const queue = {
      getRepeatableJobs: jest.fn(),
      removeRepeatableByKey: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);

    const tenantKey = 'tenant-a';
    const configId = 'cfg-1';
    const jobId = `sap-sync:${tenantKey}:${configId}`;
    const previousKey = buildLegacyRepeatableKey({
      jobId,
      suffix: '30 3 * * *',
    });

    queue.getRepeatableJobs.mockResolvedValue([
      { key: previousKey, name: 'sap-sync-job', pattern: '30 3 * * *' },
    ]);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'repeat-job' });

    const previousConfig = {
      _id: configId,
      active: true,
      mode: 'FULL',
      executionTime: '03:30',
      objectType: 'BusinessPartners',
    };

    const config = {
      _id: configId,
      active: true,
      mode: 'FULL',
      executionTime: '05:00',
      objectType: 'BusinessPartners',
    };

    const result = await syncScheduledJob({ tenantKey, config, previousConfig });

    expect(result).toEqual({ action: 'registered' });
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith(previousKey);
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey,
      configId,
      mode: 'FULL',
      executionTime: '05:00',
      repeatPattern: '0 5 * * *',
      repeatTimezone: 'America/Costa_Rica',
    }));
  });

  it('replaces the previous INCREMENTAL schedule using the legacy hashed key', async () => {
    const queue = {
      getRepeatableJobs: jest.fn(),
      removeRepeatableByKey: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);

    const tenantKey = 'tenant-b';
    const configId = 'cfg-2';
    const jobId = `sap-sync:${tenantKey}:${configId}`;
    const previousKey = buildLegacyRepeatableKey({
      jobId,
      suffix: String(5 * 60 * 1000),
    });

    queue.getRepeatableJobs.mockResolvedValue([
      { key: previousKey, name: 'sap-sync-job', every: String(5 * 60 * 1000) },
    ]);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'repeat-job' });

    const previousConfig = {
      _id: configId,
      active: true,
      mode: 'INCREMENTAL',
      intervalMinutes: 5,
      objectType: 'Items',
    };

    const config = {
      _id: configId,
      active: true,
      mode: 'INCREMENTAL',
      intervalMinutes: 10,
      objectType: 'Items',
    };

    const result = await syncScheduledJob({ tenantKey, config, previousConfig });

    expect(result).toEqual({ action: 'registered' });
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith(previousKey);
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey,
      configId,
      mode: 'INCREMENTAL',
      intervalMinutes: 10,
      repeatEvery: 10 * 60 * 1000,
      repeatTimezone: null,
    }));
  });

  it('bootstrap skips creating a job when the tenant config already exists in BullMQ', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([
        { key: 'sap-sync:tenant-c:cfg-3', name: 'sap-sync-job' },
      ]),
      removeRepeatableByKey: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockListActiveTenants.mockResolvedValue([
      { client: { tenantKey: 'tenant-c' } },
    ]);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'cfg-3',
              active: true,
              mode: 'INCREMENTAL',
              intervalMinutes: 10,
              objectType: 'Items',
            },
          ]),
        }),
      },
    });

    const result = await bootstrapScheduledJobs();

    expect(result).toEqual(expect.objectContaining({
      tenantsScanned: 1,
      configsScheduled: 0,
      configsSkippedExisting: 1,
      configsRemoved: 0,
      orphanRemoved: 0,
    }));
    expect(mockAddScheduledSapSyncJob).not.toHaveBeenCalled();
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('bootstrap creates a job when the tenant config does not exist in BullMQ', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockListActiveTenants.mockResolvedValue([
      { client: { tenantKey: 'tenant-d' } },
    ]);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'cfg-4',
              active: true,
              mode: 'FULL',
              executionTime: '05:00',
              objectType: 'BusinessPartners',
            },
          ]),
        }),
      },
    });

    const result = await bootstrapScheduledJobs();

    expect(result).toEqual(expect.objectContaining({
      tenantsScanned: 1,
      configsScheduled: 1,
      configsSkippedExisting: 0,
      configsRemoved: 0,
      orphanRemoved: 0,
    }));
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey: 'tenant-d',
      configId: 'cfg-4',
      repeatPattern: '0 5 * * *',
      repeatTimezone: 'America/Costa_Rica',
    }));
  });
});
