import { jest } from '@jest/globals';
import {
  LOCK_RETRY_ERROR_CODE,
  createSapSyncJobProcessor,
} from '../../../src/interfaces/jobs/sap-sync.job.js';

function createJob(data = {}) {
  return {
    id: 'job-1',
    name: 'sap-sync-job',
    data,
    updateData: jest.fn().mockResolvedValue(undefined),
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
      execute: jest.fn().mockResolvedValue(undefined),
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
    expect(syncUseCase.execute).toHaveBeenCalledWith({ config, tenantModels });
    expect(lockAdapter.release).toHaveBeenCalledWith(lock);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      duration: 1000,
      status: 'success',
    }));
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

    await expect(processor(createJob({
      tenantKey: 'tenant-a',
      configId: 'cfg-1',
      triggerType: 'manual',
    }))).rejects.toMatchObject({
      code: LOCK_RETRY_ERROR_CODE,
    });
  });
});

