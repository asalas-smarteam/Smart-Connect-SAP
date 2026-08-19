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

  // EL FALLO REAL: Mongo rechazo el $set entero por una clave del audit
  // ("The dollar ($) prefixed field '$select' in 'sapAudit.sapCalls.0.params.$select' is not
  // valid for storage"), asi que se perdio tambien el status y el lastError del evento: dos
  // eventos quedaron colgados en 'sap_order_created' con la orden ya creada en SAP. La
  // auditoria es soporte y nunca puede impedir que se guarde el estado.
  describe('cuando Mongo rechaza el $set por culpa del sapAudit', () => {
    function buildRejectingUpdateOne() {
      return jest.fn()
        .mockRejectedValueOnce(new Error(
          "The dollar ($) prefixed field '$select' in 'sapAudit.sapCalls.0.params.$select' is not valid for storage."
        ))
        .mockResolvedValue({});
    }

    it('markFailed reintenta sin sapAudit para no perder status ni lastError', async () => {
      const updateOne = buildRejectingUpdateOne();
      const logger = { error: jest.fn() };
      const repository = new MongooseWebhookEventRepository({
        WebhookEvent: { updateOne },
        batchSize: 1,
        logger,
      });

      await repository.markFailed({ _id: 'event-1' }, {
        status: 'waiting',
        retries: 1,
        lastError: 'SP - ERROR',
        sapAudit: { sapCalls: [{ params: { $select: 'CardCode' } }] },
      });

      expect(updateOne).toHaveBeenCalledTimes(2);
      const [, { $set }] = updateOne.mock.calls[1];
      expect(Object.keys($set)).not.toContain('sapAudit');
      expect($set).toMatchObject({ status: 'waiting', retries: 1, lastError: 'SP - ERROR' });
      expect(logger.error).toHaveBeenCalled();
    });

    it('markCompleted reintenta sin sapAudit para no dejar el evento sin cerrar', async () => {
      const updateOne = buildRejectingUpdateOne();
      const repository = new MongooseWebhookEventRepository({
        WebhookEvent: { updateOne },
        batchSize: 1,
      });

      await repository.markCompleted({ _id: 'event-1' }, {
        docEntry: 10,
        docNum: 20,
        cardCode: 'CL001',
        sapAudit: { sapCalls: [{ params: { $top: 1 } }] },
      });

      expect(updateOne).toHaveBeenCalledTimes(2);
      const [, { $set }] = updateOne.mock.calls[1];
      expect(Object.keys($set)).not.toContain('sapAudit');
      expect($set.status).toBe('completed');
    });

    // Si el rechazo no viene del audit, el reintento sin audit fallaria igual: el error
    // tiene que propagarse para que el batch lo maneje, no tragarse en un bucle inutil.
    it('propaga el error cuando el reintento sin sapAudit tambien falla', async () => {
      const updateOne = jest.fn().mockRejectedValue(new Error('Mongo down'));
      const repository = new MongooseWebhookEventRepository({
        WebhookEvent: { updateOne },
        batchSize: 1,
      });

      await expect(
        repository.markFailed({ _id: 'event-1' }, {
          status: 'waiting',
          retries: 1,
          lastError: 'SP - ERROR',
          sapAudit: { sapCalls: [] },
        })
      ).rejects.toThrow('Mongo down');
    });

    it('no reintenta cuando no habia sapAudit en el $set', async () => {
      const updateOne = jest.fn().mockRejectedValue(new Error('Mongo down'));
      const repository = new MongooseWebhookEventRepository({
        WebhookEvent: { updateOne },
        batchSize: 1,
      });

      await expect(
        repository.markFailed({ _id: 'event-1' }, {
          status: 'waiting',
          retries: 1,
          lastError: 'SP - ERROR',
        })
      ).rejects.toThrow('Mongo down');
      expect(updateOne).toHaveBeenCalledTimes(1);
    });
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

  // El cupo de dedup lo libera SOLO `errored`, que es el único estado reenviable. Se calcula
  // del status y no se pone en `false` a secas porque markFailed también se llama con
  // `waiting`: el camino de liberación de safelyHandleProcessingError. Un evento que sigue en
  // cola liberando su cupo dejaría entrar un segundo envío en paralelo, que es exactamente el
  // agujero que el índice único viene a tapar.
  describe('dedupActive', () => {
    function runMarkFailed({ eventType, status }) {
      const updateOne = jest.fn().mockResolvedValue({});
      const repository = new MongooseWebhookEventRepository({
        WebhookEvent: { updateOne },
        batchSize: 1,
      });

      return repository
        .markFailed({ _id: 'event-1', eventType }, { status, retries: 1, lastError: 'boom' })
        .then(() => updateOne.mock.calls[0][1].$set);
    }

    it('lo libera cuando el evento queda errored', async () => {
      const $set = await runMarkFailed({ eventType: 'createDeal', status: 'errored' });

      expect($set.dedupActive).toBe(false);
    });

    it('lo mantiene cuando el evento vuelve a la cola en waiting', async () => {
      const $set = await runMarkFailed({ eventType: 'createDeal', status: 'waiting' });

      expect($set.dedupActive).toBe(true);
    });

    it('lo mantiene cuando SAP ya creó el documento', async () => {
      const $set = await runMarkFailed({
        eventType: 'createQuotation',
        status: 'sap_created_hubspot_error',
      });

      expect($set.dedupActive).toBe(true);
    });

    it('no lo escribe para updateQuotation, que no participa del dedup', async () => {
      const $set = await runMarkFailed({ eventType: 'updateQuotation', status: 'errored' });

      expect(Object.keys($set)).not.toContain('dedupActive');
    });

    it('no lo escribe para un evento legacy sin eventType', async () => {
      const $set = await runMarkFailed({ eventType: undefined, status: 'errored' });

      expect(Object.keys($set)).not.toContain('dedupActive');
    });

    // markCompleted NUNCA debe tocar dedupActive: si un cambio futuro lo pusiera en `false`
    // ahí, un deal ya sincronizado con SAP se volvería reenviable, y en el flujo createDeal
    // eso es una orden duplicada sin ninguna red que lo atrape (ese flujo no escribe
    // SapDocumentLink; el índice único es su única protección). A diferencia de markFailed,
    // que sí libera el cupo cuando el estado es errored, completed nunca libera nada.
    it('markCompleted no escribe dedupActive, así que nunca libera el cupo de un deal ya sincronizado', async () => {
      const updateOne = jest.fn().mockResolvedValue({});
      const repository = new MongooseWebhookEventRepository({
        WebhookEvent: { updateOne },
        batchSize: 1,
      });
      const event = { _id: 'event-1', eventType: 'createDeal' };

      await repository.markCompleted(event, { docEntry: 10, docNum: 20, cardCode: 'CL001' });

      const [, { $set }] = updateOne.mock.calls[0];
      expect(Object.keys($set)).not.toContain('dedupActive');
    });
  });
});
