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
  buildScheduledJobId: ({ tenantKey, configId, slotIndex = null }) => (
    Number.isInteger(slotIndex)
      ? `sap-sync:${tenantKey}:${String(configId)}:${slotIndex}`
      : `sap-sync:${tenantKey}:${String(configId)}`
  ),
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

  it('registers one scheduler per hour for a multi-hour FULL config', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    const config = {
      _id: 'cfg-printer',
      active: true,
      mode: 'FULL',
      executionTime: ['15:00', '07:00', '12:00'],
      executionDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      objectType: 'product',
    };

    const result = await syncScheduledJob({ tenantKey: 'printer', config });

    expect(result).toEqual({ action: 'registered' });
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledTimes(3);

    const calls = mockAddScheduledSapSyncJob.mock.calls.map(([schedule]) => ({
      slotIndex: schedule.slotIndex,
      executionTime: schedule.executionTime,
      repeatPattern: schedule.repeatPattern,
      repeatTimezone: schedule.repeatTimezone,
    }));

    expect(calls).toEqual([
      { slotIndex: 0, executionTime: '07:00', repeatPattern: '0 7 * * 1,2,3,4,5,6', repeatTimezone: 'America/Costa_Rica' },
      { slotIndex: 1, executionTime: '12:00', repeatPattern: '0 12 * * 1,2,3,4,5,6', repeatTimezone: 'America/Costa_Rica' },
      { slotIndex: 2, executionTime: '15:00', repeatPattern: '0 15 * * 1,2,3,4,5,6', repeatTimezone: 'America/Costa_Rica' },
    ]);
  });

  it('schedules a legacy string executionTime as slot 0', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    const config = {
      _id: 'cfg-legacy',
      active: true,
      mode: 'FULL',
      executionTime: '05:00',
      objectType: 'Items',
    };

    await syncScheduledJob({ tenantKey: 'tenant-legacy', config });

    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledTimes(1);
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      slotIndex: 0,
      executionTime: '05:00',
      repeatPattern: '0 5 * * *',
    }));
  });

  it('removes the job when a FULL config has no valid execution times', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);

    const config = {
      _id: 'cfg-empty',
      active: true,
      mode: 'FULL',
      executionTime: [],
      objectType: 'Items',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-empty', config });

    expect(result).toEqual({ action: 'removed' });
    expect(mockAddScheduledSapSyncJob).not.toHaveBeenCalled();
  });

  it('logs and skips scheduling when executionTime holds garbage', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn(),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);

    const config = {
      _id: 'cfg-garbage',
      active: true,
      mode: 'FULL',
      executionTime: ['not-a-time'],
      objectType: 'Items',
    };

    const result = await syncScheduledJob({ tenantKey: 'tenant-garbage', config });

    expect(result).toEqual({ action: 'removed' });
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Invalid executionTime on ClientConfig, schedule skipped',
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

  it('drops the schedulers of hours that were removed from the config', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([
        { key: 'sap-sync:printer:cfg-shrink:0', name: 'sap-sync-job', template: { data: {} } },
        { key: 'sap-sync:printer:cfg-shrink:1', name: 'sap-sync-job', template: { data: {} } },
        { key: 'sap-sync:printer:cfg-shrink:2', name: 'sap-sync-job', template: { data: {} } },
      ]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });

    // Sin previousConfig a propósito: la lista de nombres a borrar es fija, no derivada del estado
    // anterior.
    const config = {
      _id: 'cfg-shrink',
      active: true,
      mode: 'FULL',
      executionTime: ['07:00'],
      objectType: 'product',
    };

    await syncScheduledJob({ tenantKey: 'printer', config });

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:printer:cfg-shrink:0');
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:printer:cfg-shrink:1');
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:printer:cfg-shrink:2');
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledTimes(1);
  });

  it('bootstrap replaces a legacy flat scheduler instead of leaving it running beside slot 0', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([
        { key: 'sap-sync:tenant-e:cfg-5', name: 'sap-sync-job', template: { data: {} } },
      ]),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });
    mockListActiveTenants.mockResolvedValue([{ client: { tenantKey: 'tenant-e' } }]);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'cfg-5',
              active: true,
              mode: 'FULL',
              executionTime: '05:00',
              objectType: 'Items',
            },
          ]),
        }),
      },
    });

    const result = await bootstrapScheduledJobs();

    expect(result).toEqual(expect.objectContaining({ configsScheduled: 1 }));
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('sap-sync:tenant-e:cfg-5');
    expect(mockAddScheduledSapSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      slotIndex: 0,
      repeatPattern: '0 5 * * *',
    }));
  });

  it('bootstrap upsert keeps every slot it just created', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn(),
      removeRepeatableByKey: jest.fn(),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    mockGetSapSyncQueue.mockReturnValue(queue);
    mockAddScheduledSapSyncJob.mockResolvedValue({ id: 'scheduled-job' });
    mockListActiveTenants.mockResolvedValue([{ client: { tenantKey: 'printer' } }]);
    mockGetTenantModels.mockResolvedValue({
      ClientConfig: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'cfg-multi',
              active: true,
              mode: 'FULL',
              executionTime: ['07:00', '12:00', '15:00'],
              objectType: 'product',
            },
          ]),
        }),
      },
    });

    // El barrido de huérfanos vuelve a leer la cola al final: devolvemos los tres slots recién
    // creados para comprobar que NO se los lleva por delante.
    queue.getJobSchedulers.mockImplementation(async () => ([
      { key: 'sap-sync:printer:cfg-multi:0', name: 'sap-sync-job', template: { data: {} } },
      { key: 'sap-sync:printer:cfg-multi:1', name: 'sap-sync-job', template: { data: {} } },
      { key: 'sap-sync:printer:cfg-multi:2', name: 'sap-sync-job', template: { data: {} } },
    ]));

    const result = await bootstrapScheduledJobs({ upsertExisting: true });

    expect(result).toEqual(expect.objectContaining({
      configsScheduled: 1,
      orphanRemoved: 0,
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
