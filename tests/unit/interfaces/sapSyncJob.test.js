import { jest } from '@jest/globals';
import {
  LOCK_RETRY_ERROR_CODE,
  createSapSyncJobProcessor,
  shouldRunIncrementalScheduleNow,
} from '../../../src/interfaces/jobs/sap-sync.job.js';

function createJob(data = {}) {
  return {
    id: 'job-1',
    name: 'sap-sync-job',
    data,
    updateData: jest.fn().mockResolvedValue(undefined),
    log: jest.fn().mockResolvedValue(undefined),
  };
}

describe('sap sync job processor', () => {
  it('executes a SAP sync job with tenant lock protection', async () => {
    const config = { _id: 'cfg-1', active: true };
    const tenantModels = { ClientConfig: {} };
    const tenantRepository = {
      loadConfig: jest.fn().mockResolvedValue({ tenantModels, config }),
    };
    const lock = { key: 'lock', token: 'token', ttlMs: 60000 };
    const lockAdapter = {
      acquire: jest.fn().mockResolvedValue(lock),
      extend: jest.fn(),
      release: jest.fn().mockResolvedValue(true),
    };
    const syncUseCase = {
      execute: jest.fn().mockResolvedValue({
        ok: true,
        metrics: {
          recordsProcessed: 3,
          hubspotCreated: 1,
          hubspotUpdated: 2,
          hubspotSent: 3,
          hubspotFailed: 0,
        },
      }),
    };
    const processor = createSapSyncJobProcessor({
      tenantRepository,
      lockAdapter,
      syncUseCase,
      dateProvider: jest
        .fn()
        .mockReturnValueOnce(new Date('2026-05-05T00:00:00.000Z'))
        .mockReturnValueOnce(new Date('2026-05-05T00:00:01.000Z')),
    });
    const job = createJob({
      tenantKey: 'tenant-a',
      configId: 'cfg-1',
      triggerType: 'manual',
    });

    const result = await processor(job);

    expect(tenantRepository.loadConfig).toHaveBeenCalledWith({
      tenantKey: 'tenant-a',
      configId: 'cfg-1',
    });
    expect(lockAdapter.acquire).toHaveBeenCalledWith('tenant-a');
    expect(syncUseCase.execute).toHaveBeenCalledWith({
      config,
      tenantContext: {
        tenantKey: 'tenant-a',
        tenantModels,
      },
    });
    expect(lockAdapter.release).toHaveBeenCalledWith(lock);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      duration: 1000,
      status: 'success',
      metrics: {
        recordsProcessed: 3,
        hubspotCreated: 1,
        hubspotUpdated: 2,
        hubspotSent: 3,
        hubspotFailed: 0,
      },
    }));
    expect(job.log).toHaveBeenCalledWith(expect.stringContaining('SAP sync job started'));
    expect(job.log).toHaveBeenCalledWith(expect.stringContaining('SAP sync job completed'));
    expect(job.log).toHaveBeenCalledWith(expect.stringContaining('"recordsProcessed":3'));
    expect(job.log).toHaveBeenCalledWith(expect.stringContaining('"hubspotCreated":1'));
    expect(job.log).toHaveBeenCalledWith(expect.stringContaining('"hubspotUpdated":2'));
  });

  it('throws a tenant lock retry error when the lock is already held', async () => {
    const processor = createSapSyncJobProcessor({
      tenantRepository: {
        loadConfig: jest.fn().mockResolvedValue({
          tenantModels: {},
          config: { _id: 'cfg-1', active: true },
        }),
      },
      lockAdapter: {
        acquire: jest.fn().mockResolvedValue(null),
        extend: jest.fn(),
        release: jest.fn(),
      },
      syncUseCase: {
        execute: jest.fn(),
      },
    });

    const job = createJob({
      tenantKey: 'tenant-a',
      configId: 'cfg-1',
      triggerType: 'manual',
    });

    await expect(processor(job)).rejects.toMatchObject({
      code: LOCK_RETRY_ERROR_CODE,
    });
    expect(job.log).toHaveBeenCalledWith(expect.stringContaining('SAP sync job failed'));
  });

  it('skips scheduled incremental jobs outside configured execution window', async () => {
    const tenantRepository = {
      loadConfig: jest.fn().mockResolvedValue({
        tenantModels: {},
        config: {
          _id: 'cfg-1',
          active: true,
          mode: 'INCREMENTAL',
          intervalMinutes: 5,
          startTime: '08:00',
          endTime: '18:00',
        },
      }),
    };
    const lockAdapter = {
      acquire: jest.fn(),
      extend: jest.fn(),
      release: jest.fn(),
    };
    const syncUseCase = {
      execute: jest.fn(),
    };
    const processor = createSapSyncJobProcessor({
      tenantRepository,
      lockAdapter,
      syncUseCase,
      dateProvider: jest.fn(() => new Date('2026-05-05T14:03:00.000Z')),
    });
    const job = createJob({
      tenantKey: 'tenant-a',
      configId: 'cfg-1',
      triggerType: 'scheduled',
    });

    const result = await processor(job);

    expect(result).toEqual({ skipped: true, reason: 'outside-incremental-window' });
    expect(lockAdapter.acquire).not.toHaveBeenCalled();
    expect(syncUseCase.execute).not.toHaveBeenCalled();
    expect(job.log).toHaveBeenCalledWith(expect.stringContaining('SAP sync job skipped outside incremental window'));
  });

  it('matches incremental window using America/Costa_Rica time and interval offset', () => {
    const config = {
      mode: 'INCREMENTAL',
      intervalMinutes: 5,
      startTime: '08:00',
      endTime: '18:00',
    };

    expect(shouldRunIncrementalScheduleNow(config, new Date('2026-05-05T14:05:00.000Z'))).toBe(true);
    expect(shouldRunIncrementalScheduleNow(config, new Date('2026-05-05T14:03:00.000Z'))).toBe(false);
    expect(shouldRunIncrementalScheduleNow(config, new Date('2026-05-06T01:00:00.000Z'))).toBe(false);
  });
});
