import { jest } from '@jest/globals';
import {
  normalizeSyncLogObjectType,
  startSyncLog,
} from '../../src/infrastructure/sync/syncLog.service.js';

describe('syncLog.service', () => {
  it.each([
    ['product', 'Product'],
    ['contact', 'Contact'],
    ['deal', 'Deal'],
    ['company', 'Company'],
    ['Products', 'Product'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeSyncLogObjectType(input)).toBe(expected);
  });

  it('stores the normalized object type when starting a sync log', async () => {
    const create = jest.fn().mockResolvedValue({ _id: 'log-1' });

    await startSyncLog({
      tenantModels: {
        SyncLog: { create },
      },
      clientConfigId: 'cfg-1',
      objectType: 'contact',
      startedAt: new Date('2026-05-06T17:28:19.040Z'),
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      clientConfigId: 'cfg-1',
      objectType: 'Contact',
      recordsProcessed: 0,
      sent: 0,
      failed: 0,
    }));
  });
});
