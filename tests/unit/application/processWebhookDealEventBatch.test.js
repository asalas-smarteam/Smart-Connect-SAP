import { jest } from '@jest/globals';
import ProcessWebhookDealEventBatch from '../../../src/application/use-cases/ProcessWebhookDealEventBatch.js';

describe('ProcessWebhookDealEventBatch', () => {
  it('marks claimed events as completed after processing', async () => {
    const event = { _id: 'event-1', payload: { deal: { hs_object_id: 'deal-1' } } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const processWebhookDealEvent = jest.fn().mockResolvedValue({
      cardCode: 'C20000',
      docEntry: 10,
      docNum: 20,
    });
    const logger = { info: jest.fn(), error: jest.fn() };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent,
      logger,
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({
      tenantModels: { WebhookEvent: {} },
      tenantId: 'tenant-id',
      tenantKey: 'tenant-key',
      portalId: 'portal-id',
    });

    expect(processWebhookDealEvent).toHaveBeenCalledWith({
      event,
      tenantModels: { WebhookEvent: {} },
      tenantId: 'tenant-id',
      tenantKey: 'tenant-key',
      portalId: 'portal-id',
    });
    expect(repository.markCompleted).toHaveBeenCalledWith(event, {
      cardCode: 'C20000',
      docEntry: 10,
      docNum: 20,
    });
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(summary).toEqual({
      processed: 1,
      completed: 1,
      retried: 0,
      errored: 0,
      skipped: 0,
      errorDetails: [],
    });
  });

  it('moves transient failures back to waiting while retries remain', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const processWebhookDealEvent = jest.fn().mockRejectedValue(new Error('SAP timeout'));

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent,
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'waiting',
      retries: 1,
      lastError: 'SAP timeout',
    });
    expect(summary.retried).toBe(1);
    expect(summary.errored).toBe(0);
  });

  it('marks permanent failures as errored and records sync log details', async () => {
    const event = { _id: 'event-1', retries: 0, payload: { deal: {} } };
    const error = new Error('ItemCode is required');
    error.permanent = true;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const buildWebhookSyncErrorEntry = jest.fn((entry) => ({
      payloadHubspot: entry.payloadHubspot,
      responseSap: entry.responseSap,
    }));
    const buildErrorResponseSnapshot = jest.fn(() => ({ message: error.message }));

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry,
      buildErrorResponseSnapshot,
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'errored',
      retries: 3,
      lastError: 'ItemCode is required',
    });
    expect(summary.errored).toBe(1);
    expect(summary.errorDetails).toEqual([
      {
        payloadHubspot: event.payload,
        responseSap: { message: 'ItemCode is required' },
      },
    ]);
  });
});
