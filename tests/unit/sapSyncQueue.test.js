import { jest } from '@jest/globals';

const mockUpsertJobScheduler = jest.fn();
const mockAdd = jest.fn();
const mockClose = jest.fn();
const mockQueueConstructor = jest.fn(() => ({
  add: mockAdd,
  close: mockClose,
  upsertJobScheduler: mockUpsertJobScheduler,
}));

jest.unstable_mockModule('bullmq', () => ({
  Queue: mockQueueConstructor,
}));

jest.unstable_mockModule('../../src/infrastructure/queue/bullmqRedis.js', () => ({
  getSharedBullMQConnection: jest.fn(() => ({ redis: true })),
}));

const {
  SAP_SYNC_JOB_NAME,
  SAP_SYNC_QUEUE_NAME,
  addScheduledSapSyncJob,
  buildScheduledSapSyncJobTemplate,
  closeSapSyncQueue,
} = await import('../../src/infrastructure/queue/sapSync.queue.js');

describe('sapSync.queue', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await closeSapSyncQueue();
  });

  afterEach(async () => {
    await closeSapSyncQueue();
  });

  it('uses BullMQ job schedulers for daily FULL schedules', async () => {
    mockUpsertJobScheduler.mockResolvedValue({ id: 'scheduled-job' });

    await addScheduledSapSyncJob({
      tenantKey: 'tenant-a',
      configId: 'cfg-1',
      objectType: 'product',
      mode: 'FULL',
      intervalMinutes: null,
      executionTime: '05:00',
      executionDays: ['Monday'],
      repeatPattern: '0 5 * * *',
      repeatTimezone: 'America/Costa_Rica',
    });

    expect(mockQueueConstructor).toHaveBeenCalledWith(SAP_SYNC_QUEUE_NAME, expect.any(Object));
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'sap-sync:tenant-a:cfg-1',
      {
        pattern: '0 5 * * *',
        tz: 'America/Costa_Rica',
      },
      {
        name: SAP_SYNC_JOB_NAME,
        data: expect.objectContaining({
          tenantKey: 'tenant-a',
          configId: 'cfg-1',
          mode: 'FULL',
          executionTime: '05:00',
          executionDays: ['Monday'],
          triggerType: 'scheduled',
        }),
      }
    );
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('builds interval scheduler template for INCREMENTAL schedules', () => {
    const template = buildScheduledSapSyncJobTemplate({
      tenantKey: 'tenant-b',
      configId: 'cfg-2',
      objectType: 'Items',
      mode: 'INCREMENTAL',
      intervalMinutes: 10,
      startTime: '08:00',
      endTime: '18:00',
      repeatEvery: 10 * 60 * 1000,
    });

    expect(template).toEqual({
      schedulerId: 'sap-sync:tenant-b:cfg-2',
      repeatOptions: {
        every: 10 * 60 * 1000,
      },
      jobTemplate: {
        name: SAP_SYNC_JOB_NAME,
        data: expect.objectContaining({
          tenantKey: 'tenant-b',
          configId: 'cfg-2',
          mode: 'INCREMENTAL',
          intervalMinutes: 10,
          startTime: '08:00',
          endTime: '18:00',
          triggerType: 'scheduled',
        }),
      },
    });
  });
});
