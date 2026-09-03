import { jest } from '@jest/globals';
import {
  DEDUPLICATED_EVENT_TYPES,
  RESENDABLE_STATUS,
  findBlockingEvent,
  queueWebhookEvent,
} from '../../../src/infrastructure/webhook/webhookEvent.service.js';

const ALL_STATUSES = [
  'waiting',
  'inprocess',
  'sap_order_created',
  'sap_created_hubspot_error',
  'completed',
  'errored',
  'report',
];

function buildWebhookEvent({ blocking = null } = {}) {
  return {
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(blocking),
      }),
    }),
    create: jest.fn(async (document) => ({ ...document, _id: 'new-event' })),
  };
}

const payload = { deal: { hs_object_id: 'deal-1' } };

describe('DEDUPLICATED_EVENT_TYPES', () => {
  // updateQuotation NO está a propósito: una cotización se actualiza muchas veces y cada
  // envío es legítimo. Agregarlo bloquearía la segunda actualización de una cotización que ya
  // sincronizó bien, porque su evento anterior quedó `completed`.
  it('cubre los cinco tipos deduplicados y deja updateQuotation afuera', () => {
    expect([...DEDUPLICATED_EVENT_TYPES].sort()).toEqual([
      'convertQuotationToOrder',
      'createDeal',
      'createQuotation',
      'inventoryTransferRequest',
      'purchaseQuotation',
    ]);
    expect(DEDUPLICATED_EVENT_TYPES.has('updateQuotation')).toBe(false);
  });
});

describe('findBlockingEvent', () => {
  it('excluye solo el estado reenviable de la consulta', async () => {
    const WebhookEvent = buildWebhookEvent();

    await findBlockingEvent({ WebhookEvent, eventType: 'createDeal', payload });

    expect(WebhookEvent.findOne).toHaveBeenCalledWith({
      eventType: 'createDeal',
      'payload.deal.hs_object_id': 'deal-1',
      status: { $ne: RESENDABLE_STATUS },
    });
  });

  it('devuelve null sin consultar cuando el payload no trae dealId', async () => {
    const WebhookEvent = buildWebhookEvent();

    await expect(
      findBlockingEvent({ WebhookEvent, eventType: 'createDeal', payload: {} })
    ).resolves.toBeNull();
    expect(WebhookEvent.findOne).not.toHaveBeenCalled();
  });
});

describe('queueWebhookEvent', () => {
  it.each(ALL_STATUSES.filter((status) => status !== 'errored'))(
    'trata como duplicado cuando ya existe un evento en %s',
    async (status) => {
      const WebhookEvent = buildWebhookEvent({ blocking: { _id: 'existing', status } });

      const result = await queueWebhookEvent({
        WebhookEvent,
        eventType: 'createDeal',
        payload,
      });

      expect(result).toEqual({ duplicated: true, eventId: 'existing' });
      expect(WebhookEvent.create).not.toHaveBeenCalled();
    }
  );

  it('inserta un evento nuevo cuando el anterior quedó errored', async () => {
    // findOne ya filtra por status distinto de errored, así que un errored previo no aparece.
    const WebhookEvent = buildWebhookEvent({ blocking: null });

    const result = await queueWebhookEvent({
      WebhookEvent,
      eventType: 'createDeal',
      payload,
    });

    expect(result).toEqual({ duplicated: false, eventId: 'new-event' });
    expect(WebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'createDeal',
        status: 'waiting',
        retries: 0,
        maxRetries: 3,
        lastError: null,
        dedupActive: true,
      })
    );
  });

  it.each([...DEDUPLICATED_EVENT_TYPES])('marca dedupActive en %s', async (eventType) => {
    const WebhookEvent = buildWebhookEvent();

    await queueWebhookEvent({ WebhookEvent, eventType, payload });

    const [document] = WebhookEvent.create.mock.calls[0];
    expect(document.dedupActive).toBe(true);
  });

  it('no escribe dedupActive ni consulta duplicados en updateQuotation', async () => {
    const WebhookEvent = buildWebhookEvent();

    const result = await queueWebhookEvent({
      WebhookEvent,
      eventType: 'updateQuotation',
      payload,
    });

    expect(result).toEqual({ duplicated: false, eventId: 'new-event' });
    expect(WebhookEvent.findOne).not.toHaveBeenCalled();
    const [document] = WebhookEvent.create.mock.calls[0];
    expect(document).not.toHaveProperty('dedupActive');
  });

  it('resuelve la carrera de dos reenvíos simultáneos como duplicado', async () => {
    const WebhookEvent = buildWebhookEvent();
    // Primera consulta: nada bloquea. El create pierde la carrera contra el índice único.
    // Segunda consulta: ya hay un evento abierto, el que insertó el ganador.
    WebhookEvent.findOne
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'winner' }) }),
      });
    WebhookEvent.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));

    const result = await queueWebhookEvent({
      WebhookEvent,
      eventType: 'createDeal',
      payload,
    });

    expect(result).toEqual({ duplicated: true, eventId: 'winner' });
  });

  it('propaga cualquier error de create que no sea duplicate key', async () => {
    const WebhookEvent = buildWebhookEvent();
    WebhookEvent.create.mockRejectedValueOnce(new Error('Mongo down'));

    await expect(
      queueWebhookEvent({ WebhookEvent, eventType: 'createDeal', payload })
    ).rejects.toThrow('Mongo down');
  });
});
