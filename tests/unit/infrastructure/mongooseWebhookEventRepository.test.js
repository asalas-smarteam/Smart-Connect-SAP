import { jest } from '@jest/globals';
import MongooseWebhookEventRepository from '../../../src/infrastructure/repositories/MongooseWebhookEventRepository.js';

describe('MongooseWebhookEventRepository', () => {
  it('coerces a nested { lang, value } lastError to a string before updateOne', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markFailed(event, {
      status: 'waiting',
      retries: 1,
      lastError: {
        lang: 'en-us',
        value: 'To generate this document, first define the numbering series',
      },
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: expect.objectContaining({
          lastError: 'To generate this document, first define the numbering series',
        }),
      }
    );
    const [, { $set }] = updateOne.mock.calls[0];
    expect(typeof $set.lastError).toBe('string');
  });

  it('preserves null as lastError', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markFailed(event, {
      status: 'errored',
      retries: 3,
      lastError: null,
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: expect.objectContaining({ lastError: null }),
      }
    );
  });

  it('leaves an already-safe string lastError intact', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markFailed(event, {
      status: 'waiting',
      retries: 1,
      lastError: 'SAP timeout',
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: expect.objectContaining({ lastError: 'SAP timeout' }),
      }
    );
  });

  it('markCompleted writes sapAudit when the result carries one', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };
    const sapAudit = { payloadSap: { order: { CardCode: 'CL001' } }, capturedAt: '2026-01-01T00:00:00.000Z' };

    await repository.markCompleted(event, {
      docEntry: 10,
      docNum: 20,
      cardCode: 'CL001',
      sapAudit,
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect($set.sapAudit).toEqual(sapAudit);
  });

  it('markCompleted omits sapAudit when the result has none', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markCompleted(event, { docEntry: 10, docNum: 20, cardCode: 'CL001' });

    const [, { $set }] = updateOne.mock.calls[0];
    expect(Object.keys($set)).not.toContain('sapAudit');
  });

  it('markCompleted no longer writes payload.payloadSAP', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markCompleted(event, {
      docEntry: 10,
      docNum: 20,
      cardCode: 'CL001',
      payloadSap: { CardCode: 'CL001' },
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect(Object.keys($set)).not.toContain('payload.payloadSAP');
  });

  it('markFailed writes sapAudit when the failure carries one', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };
    const sapAudit = { payloadSap: { quotation: { CardCode: 'CL001' } }, capturedAt: '2026-01-01T00:00:00.000Z' };

    await repository.markFailed(event, {
      status: 'errored',
      retries: 3,
      lastError: 'SAP timeout',
      sapAudit,
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect($set.sapAudit).toEqual(sapAudit);
  });

  it('markFailed no longer writes payload.payloadSAP even when failure.payloadSap is given', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const WebhookEvent = { updateOne };
    const repository = new MongooseWebhookEventRepository({ WebhookEvent, batchSize: 1 });
    const event = { _id: 'event-1' };

    await repository.markFailed(event, {
      status: 'errored',
      retries: 3,
      lastError: 'SAP timeout',
      payloadSap: { CardCode: 'CL001' },
    });

    const [, { $set }] = updateOne.mock.calls[0];
    expect(Object.keys($set)).not.toContain('payload.payloadSAP');
  });
});
