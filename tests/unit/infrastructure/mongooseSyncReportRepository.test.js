import { jest } from '@jest/globals';
import MongooseSyncReportRepository, {
  SYNC_REPORT_STATUS,
} from '../../../src/infrastructure/database/repositories/MongooseSyncReportRepository.js';

describe('MongooseSyncReportRepository', () => {
  let create;
  let tenantModels;
  let repository;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({ _id: 'evt-1' });
    tenantModels = { WebhookEvent: { create } };
    repository = new MongooseSyncReportRepository();
  });

  it('writes the report to WebhookEvents with a status nothing claims', async () => {
    // The webhook processor claims on { status: 'waiting' } and does NOT filter
    // by eventType, so any claimable status would get this report processed as a
    // deal and pushed to SAP.
    await repository.record({
      tenantModels,
      eventType: 'sapDuplicateContactEmailReport',
      payload: { reportType: 'sapDuplicateContactEmailReport', duplicates: [] },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({
      eventType: 'sapDuplicateContactEmailReport',
      payload: { reportType: 'sapDuplicateContactEmailReport', duplicates: [] },
      status: SYNC_REPORT_STATUS,
      retries: 0,
      maxRetries: 0,
      lastError: null,
    });
    expect(SYNC_REPORT_STATUS).not.toBe('waiting');
  });

  it('returns null without writing when the model is unavailable', async () => {
    await expect(repository.record({
      tenantModels: {},
      eventType: 'sapDuplicateContactEmailReport',
      payload: {},
    })).resolves.toBeNull();
  });

  it('returns null rather than writing a report with no eventType or payload', async () => {
    await expect(repository.record({ tenantModels, payload: {} })).resolves.toBeNull();
    await expect(repository.record({ tenantModels, eventType: 'x' })).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('swallows a write failure so a sync run is never broken by reporting', async () => {
    create.mockRejectedValue(new Error('mongo down'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(repository.record({
      tenantModels,
      eventType: 'sapDuplicateContactEmailReport',
      payload: { duplicates: [] },
    })).resolves.toBeNull();

    consoleError.mockRestore();
  });
});
