import { jest } from '@jest/globals';
import {
  finishSyncLog,
  normalizeSyncLogObjectType,
  startSyncLog,
} from '../../src/infrastructure/sync/syncLog.service.js';

function buildSyncLogDoc() {
  const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
  return { doc: { _id: 'log-1', constructor: { updateOne } }, updateOne };
}

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

  // Sin estos tres campos en Mongo, un `sent: 13` puede ser 13 negocios movidos
  // o 13 descartes: era imposible auditar una corrida desde la base.
  it('persists updated, skipped and the reason breakdown when finishing', async () => {
    const { doc, updateOne } = buildSyncLogDoc();

    await finishSyncLog(doc, {
      status: 'completed',
      recordsProcessed: 13,
      sent: 1,
      failed: 0,
      updated: 1,
      skipped: 12,
      skippedReasons: [{ reason: 'no_deal_in_num_at_card', count: 12 }],
      finishedAt: new Date('2026-08-19T18:06:05.571Z'),
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'log-1' },
      {
        $set: expect.objectContaining({
          recordsProcessed: 13,
          sent: 1,
          updated: 1,
          skipped: 12,
          skippedReasons: [{ reason: 'no_deal_in_num_at_card', count: 12 }],
        }),
      }
    );
  });

  it('defaults the new counters to zero and an empty breakdown', async () => {
    const { doc, updateOne } = buildSyncLogDoc();

    await finishSyncLog(doc, { status: 'completed', recordsProcessed: 5, sent: 5 });

    expect(updateOne.mock.calls[0][1].$set).toEqual(expect.objectContaining({
      updated: 0,
      skipped: 0,
      skippedReasons: [],
    }));
  });

  // El Mongo de producción es < 5.0 y rechaza claves con $ al frente; un solo
  // par malo tumba el $set COMPLETO, arrastrando status y errorMessage con él.
  it('drops breakdown entries whose reason is not a safe plain string', async () => {
    const { doc, updateOne } = buildSyncLogDoc();

    await finishSyncLog(doc, {
      status: 'completed',
      skippedReasons: [
        { reason: '$set', count: 2 },
        { reason: 'a.b', count: 3 },
        { reason: 'order_link_not_found', count: 4 },
        { reason: '', count: 5 },
        'no soy un par',
      ],
    });

    expect(updateOne.mock.calls[0][1].$set.skippedReasons).toEqual([
      { reason: 'order_link_not_found', count: 4 },
    ]);
  });
});
