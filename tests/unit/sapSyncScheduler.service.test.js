import crypto from 'crypto';
import { jest } from '@jest/globals';

const mockAddScheduledSapSyncJob = jest.fn();
const mockGetSapSyncQueue = jest.fn();
const mockListActiveTenants = jest.fn();
const mockGetTenantModels = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/queue/sapSync.queue.js', () => ({
  SAP_SYNC_JOB_NAME: 'sap-sync-job',
  addScheduledSapSyncJob: mockAddScheduledSapSyncJob,
  buildScheduledJobId: ({ tenantKey, configId }) => `sap-sync:${tenantKey}:${String(configId)}`,
  getSapSyncQueue: mockGetSapSyncQueue,
}));

jest.unstable_mockModule('../../src/infrastructure/tenants/tenantSubscriptions.js', () => ({
  listActiveTenants: mockListActiveTenants,
}));

jest.unstable_mockModule('../../src/infrastructure/database/tenant/tenantDatabase.js', () => ({
  getTenantModels: mockGetTenantModels,
}));

jest.unstable_mockModule('../../src/infrastructure/logger/logger.js', () => ({
  default: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

const {
  bootstrapScheduledJobs,
  syncScheduledJob,
} = await import('../../src/infrastructure/scheduler/sapSyncScheduler.service.js');

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

  it('registers FULL schedules for any valid 24-hour execution time', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    const config = {
      _id: 'cfg-24h',
      active: true,
      mode: 'FULL',
      executionTime: '10:40',
      objectType: 'product',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-24h', config });

    expect(result).toEqual({ action: 'registered' });
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey: 'tenant-24h',
      configId: 'cfg-24h',
      mode: 'FULL',
      executionTime: '10:40',
      repeatPattern: '40 10 * * *',
      repeatTimezone: 'America/Costa_Rica',
    }));
  });

  it('registers FULL schedules only on selected execution days', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    const config = {
      _id: 'cfg-days',
      active: true,
      mode: 'FULL',
      executionTime: '11:05',
      executionDays: ['Monday', 'Wednesday', 'Friday'],
      objectType: 'product',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-days', config });

    expect(result).toEqual({ action: 'registered' });
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey: 'tenant-days',
      configId: 'cfg-days',
      executionDays: ['Monday', 'Wednesday', 'Friday'],
      repeatPattern: '5 11 * * 1,3,5',
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

  it('registers INCREMENTAL schedules inside start and end time window', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduler-job' });

    const config = {
      _id: 'cfg-window',
      active: true,
      mode: 'INCREMENTAL',
      intervalMinutes: 5,
      startTime: '08:00',
      endTime: '18:00',
      objectType: 'Items',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-window', config });

    expect(result).toEqual({ action: 'registered' });
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey: 'tenant-window',
      configId: 'cfg-window',
      intervalMinutes: 5,
      startTime: '08:00',
      endTime: '18:00',
      repeatEvery: null,
      repeatPattern: '0,5,10,15,20,25,30,35,40,45,50,55 8-18 * * *',
      repeatTimezone: 'America/Costa_Rica',
    }));
  });

  it('replaces an existing BullMQ job scheduler with the same config id', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([
        {
          key: 'sap-sync:tenant-new:cfg-new',
          name: 'sap-sync-job',
          pattern: '0 4 * * *',
          template: { data: { tenantKey: 'tenant-new', configId: 'cfg-new' } },
        },
      ]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduler-job' });

    const config = {
      _id: 'cfg-new',
      active: true,
      mode: 'FULL',
      executionTime: '05:00',
      objectType: 'Items',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-new', config });

    expect(result).toEqual({ action: 'registered' });
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:tenant-new:cfg-new');
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey: 'tenant-new',
      configId: 'cfg-new',
      repeatPattern: '0 5 * * *',
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

  it('bootstrap upsert does not purge schedules when no active tenants are loaded', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([
        { key: 'sap-sync:tenant-a:cfg-1', name: 'sap-sync-job' },
      ]),
      getJobSchedulers: jest.fn().mockResolvedValue([
        {
          key: 'sap-sync:tenant-b:cfg-2',
          name: 'sap-sync-job',
          template: { data: { tenantKey: 'tenant-b', configId: 'cfg-2' } },
        },
      ]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockListActiveTenants.mockResolvedValue([]);

    const result = await bootstrapScheduledJobs({ upsertExisting: true });

    expect(result).toEqual(expect.objectContaining({
      tenantsScanned: 0,
      orphanRemoved: 0,
    }));
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });
});
