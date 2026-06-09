import { jest } from '@jest/globals';
import MongooseSyncLogRepository from '../../../src/infrastructure/database/repositories/MongooseSyncLogRepository.js';

describe('MongooseSyncLogRepository', () => {
  it('starts and finishes sync logs through plain DTOs', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const syncLogDocument = {
      _id: 'log-1',
      status: 'running',
      constructor: { updateOne },
    };
    const SyncLog = {
      create: jest.fn().mockResolvedValue(syncLogDocument),
    };
    const repository = new MongooseSyncLogRepository();

    const syncLog = await repository.start({
      tenantContext: { tenantModels: { SyncLog } },
      clientConfigId: 'cfg-1',
      objectType: 'contact',
      startedAt: new Date('2026-05-05T00:00:00.000Z'),
    });

    expect(syncLog).toEqual({ id: 'log-1', _id: 'log-1', status: 'running' });
    expect(Object.prototype.hasOwnProperty.call(syncLog, 'constructor')).toBe(false);

    const finished = await repository.finish(syncLog, {
      status: 'completed',
      recordsProcessed: 2,
      sent: 2,
      failed: 0,
      finishedAt: new Date('2026-05-05T00:00:01.000Z'),
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'log-1' },
      {
        $set: expect.objectContaining({
          status: 'completed',
          recordsProcessed: 2,
          sent: 2,
          failed: 0,
        }),
      }
    );
    expect(finished).toEqual(expect.objectContaining({
      _id: 'log-1',
      status: 'completed',
    }));
  });
});
