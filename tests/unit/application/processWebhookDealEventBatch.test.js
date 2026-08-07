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

    const notifyWebhookFailure = jest.fn();
    useCase.notifyWebhookFailure = notifyWebhookFailure;

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'waiting',
      retries: 1,
      lastError: 'SAP timeout',
    });
    expect(summary.retried).toBe(1);
    expect(summary.errored).toBe(0);
    expect(notifyWebhookFailure).not.toHaveBeenCalled();
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

    const notifyWebhookFailure = jest.fn();
    useCase.notifyWebhookFailure = notifyWebhookFailure;

    const summary = await useCase.execute({
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });

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
    expect(notifyWebhookFailure).toHaveBeenCalledWith({
      event,
      lastError: 'ItemCode is required',
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });
  });

  it('notifies webhook failure once retries are exhausted (not permanent)', async () => {
    const event = { _id: 'event-1', retries: 2, maxRetries: 3, payload: { deal: { hs_object_id: 'deal-9' } } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const notifyWebhookFailure = jest.fn();

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(new Error('SAP timeout')),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: 'SAP timeout' })),
      notifyWebhookFailure,
    });

    const summary = await useCase.execute({
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'errored',
      retries: 3,
      lastError: 'SAP timeout',
    });
    expect(summary.errored).toBe(1);
    expect(notifyWebhookFailure).toHaveBeenCalledWith({
      event,
      lastError: 'SAP timeout',
      tenantModels: { WebhookEvent: {} },
      portalId: 'portal-1',
    });
  });

  it('does not retry when SAP order was already created before a later failure', async () => {
    const event = { _id: 'event-1', retries: 1, maxRetries: 3, payload: { deal: {} } };
    const error = new Error('HubSpot update failed');
    error.sapOrderCreated = true;
    error.sapOrderResult = {
      cardCode: 'C20000',
      docEntry: 10,
      docNum: 20,
    };
    error.sapOrderPayload = {
      CardCode: 'C20000',
      DocumentLines: [{ ItemCode: 'A0001', Quantity: 1 }],
    };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const notifyWebhookFailure = jest.fn();

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: error.message })),
      notifyWebhookFailure,
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'sap_created_hubspot_error',
      retries: 1,
      lastError: 'HubSpot update failed',
      sapResult: {
        cardCode: 'C20000',
        docEntry: 10,
        docNum: 20,
      },
    });
    expect(repository.markCompleted).not.toHaveBeenCalled();
    expect(summary.retried).toBe(0);
    expect(summary.errored).toBe(1);
    expect(notifyWebhookFailure).not.toHaveBeenCalled();
  });

  it('normalizes a nested SAP B1 error message to a string before marking the event failed', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const error = {
      response: {
        data: {
          error: {
            message: {
              lang: 'en-us',
              value: 'To generate this document, first define the numbering series',
            },
          },
        },
      },
    };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(event, {
      status: 'waiting',
      retries: 1,
      lastError: 'To generate this document, first define the numbering series',
    });
    const [, failure] = repository.markFailed.mock.calls[0];
    expect(typeof failure.lastError).toBe('string');
    expect(summary.retried).toBe(1);
  });

  it('isolates a bookkeeping failure on one event so the rest of the batch still processes', async () => {
    const events = [
      { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } },
      { _id: 'event-2', retries: 0, maxRetries: 3, payload: { deal: {} } },
      { _id: 'event-3', retries: 0, maxRetries: 3, payload: { deal: {} } },
    ];
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue(events),
      markCompleted: jest.fn(),
      markFailed: jest
        .fn()
        .mockRejectedValueOnce(new Error('Cast to string failed'))
        .mockResolvedValue(undefined),
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

    expect(processWebhookDealEvent).toHaveBeenCalledTimes(3);
    expect(summary.errored).toBe(1);
    expect(summary.retried).toBe(2);
  });

  it('never leaves an event hanging even when every bookkeeping write fails', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn().mockRejectedValue(new Error('Mongo is down')),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(new Error('SAP timeout')),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledTimes(2);
    expect(summary.errored).toBe(1);
  });

  it('marks the event terminally failed (not waiting) when SAP already created the order but bookkeeping fails', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const result = { cardCode: 'C20000', docEntry: 10, docNum: 20 };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn().mockRejectedValue(new Error('Mongo write failed')),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockResolvedValue(result),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: 'Mongo write failed' })),
    });

    const summary = await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ status: 'sap_created_hubspot_error' })
    );
    expect(repository.markFailed.mock.calls[0][1].status).not.toBe('waiting');
    expect(summary.errored).toBe(1);
    expect(summary.completed).toBe(0);
  });

  it('forwards error.sapAudit to markFailed on a normal transient failure', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { quotation: { CardCode: 'CL001' } } };
    const error = new Error('SAP timeout');
    error.sapAudit = sapAudit;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });

  it('forwards error.sapAudit to markFailed when SAP already created the order', async () => {
    const event = { _id: 'event-1', retries: 1, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } } };
    const error = new Error('HubSpot update failed');
    error.sapOrderCreated = true;
    error.sapOrderResult = { cardCode: 'C20000', docEntry: 10, docNum: 20 };
    error.sapAudit = sapAudit;
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockRejectedValue(error),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: error.message })),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });

  it('forwards result.sapAudit to markFailed when SAP succeeded but bookkeeping fails afterward', async () => {
    const event = { _id: 'event-1', retries: 0, maxRetries: 3, payload: { deal: {} } };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } } };
    const result = { cardCode: 'C20000', docEntry: 10, docNum: 20, sapAudit };
    const repository = {
      claimWaiting: jest.fn().mockResolvedValue([event]),
      markCompleted: jest.fn().mockRejectedValue(new Error('Mongo write failed')),
      markFailed: jest.fn(),
    };

    const useCase = new ProcessWebhookDealEventBatch({
      webhookEventRepository: repository,
      processWebhookDealEvent: jest.fn().mockResolvedValue(result),
      logger: { info: jest.fn(), error: jest.fn() },
      maxRetries: 3,
      buildWebhookSyncErrorEntry: jest.fn((entry) => entry),
      buildErrorResponseSnapshot: jest.fn(() => ({ message: 'Mongo write failed' })),
    });

    await useCase.execute({ tenantModels: { WebhookEvent: {} } });

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sapAudit })
    );
  });
});
