import { jest } from '@jest/globals';
import { createLineItemPriceController } from '../../src/interfaces/http/controllers/lineItemPrice.controller.js';

const mockSyncPrices = jest.fn();
const mockPreparePayload = jest.fn();
const mockMarkAsSent = jest.fn();
const mockMarkAsError = jest.fn();
const mockStartSyncLog = jest.fn();
const mockFinishSyncLog = jest.fn();

function buildReply() {
  return {
    code: jest.fn().mockReturnThis(),
    send: jest.fn((payload) => payload),
  };
}

function buildController() {
  return createLineItemPriceController({
    tenantModelsResolver: {
      resolve: (req) => req.tenantModels,
    },
    webhookPayload: {
      preparePayload: mockPreparePayload,
      markAsSent: mockMarkAsSent,
      markAsError: mockMarkAsError,
    },
    syncLogGateway: {
      start: mockStartSyncLog,
      finish: mockFinishSyncLog,
      buildErrorResponseSnapshot: (error) => ({ message: error.message }),
      buildWebhookSyncErrorEntry: (value) => value,
    },
    syncLineItemPrices: {
      execute: mockSyncPrices,
    },
  });
}

describe('lineItemPrice.controller syncPrices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartSyncLog.mockResolvedValue({ _id: 'sync-log-1' });
    mockPreparePayload.mockImplementation(async (payload) => ({
      skip: false,
      payload,
      executionId: null,
    }));
  });

  it('returns the enriched payload and update summary', async () => {
    const reply = buildReply();
    const req = {
      body: [
        {
          cardCode: 'C20000',
          lineItems: [{ itemCode: 'A0001', id: '53747313682' }],
        },
      ],
      tenantModels: {},
      tenant: { client: { hubspot: { portalId: '12345' } } },
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockSyncPrices.mockResolvedValue({
      data: {
        cardCode: 'C20000',
        dealId: 'deal-1',
        totalAmount: 1408.7,
        lineItems: [
          {
            itemCode: 'A0001',
            id: '53747313682',
            quantity: 2,
            Price: 704.35,
            Currency: 'C$',
            Discount: 0.0,
            lineTotal: 1408.7,
          },
        ],
      },
      meta: {
        requestedCount: 1,
        updatedCount: 1,
        dealUpdated: true,
      },
    });

    await buildController().syncPrices(req, reply);

    expect(mockStartSyncLog).toHaveBeenCalledWith({
      tenantModels: req.tenantModels,
      objectType: 'Product',
    });
    expect(mockPreparePayload).toHaveBeenCalledWith(req.body[0], {
      tenantModels: req.tenantModels,
      tenant: req.tenant,
      tenantKey: req.tenantKey,
    });
    expect(reply.send).toHaveBeenCalledWith({
      ok: true,
      data: {
        cardCode: 'C20000',
        dealId: 'deal-1',
        totalAmount: 1408.7,
        lineItems: [
          {
            itemCode: 'A0001',
            id: '53747313682',
            quantity: 2,
            Price: 704.35,
            Currency: 'C$',
            Discount: 0.0,
            lineTotal: 1408.7,
          },
        ],
      },
      meta: {
        requestedCount: 1,
        updatedCount: 1,
        dealUpdated: true,
      },
    });
    expect(mockMarkAsSent).not.toHaveBeenCalled();
    expect(mockFinishSyncLog).toHaveBeenCalledWith(
      { _id: 'sync-log-1' },
      expect.objectContaining({
        status: 'completed',
        recordsProcessed: 1,
        sent: 1,
        failed: 0,
      })
    );
  });

  // Un éxito parcial cerraba el syncLog con contadores derivados sólo de las líneas
  // sobrevivientes, así que una línea descartada por un 404 no figuraba ni como procesada ni
  // como fallida y la gente arma alertas sobre esos contadores.
  it('counts the skipped lines in the sync log of a partial success', async () => {
    const reply = buildReply();
    const req = {
      body: [
        {
          cardCode: 'C20000',
          lineItems: [{ itemCode: 'A0001', id: 'line-1' }],
        },
      ],
      tenantModels: {},
      tenant: {},
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockSyncPrices.mockResolvedValue({
      data: { cardCode: 'C20000', dealId: 'deal-1', totalAmount: 100, lineItems: [] },
      meta: {
        requestedCount: 2,
        updatedCount: 1,
        skippedCount: 3,
        dealUpdated: true,
      },
    });

    await buildController().syncPrices(req, reply);

    expect(mockFinishSyncLog).toHaveBeenCalledWith(
      { _id: 'sync-log-1' },
      expect.objectContaining({
        status: 'completed',
        // 2 que llegaron a la escritura + 3 descartadas antes.
        recordsProcessed: 5,
        sent: 1,
        // La que no se actualizó, más las 3 descartadas.
        failed: 4,
      })
    );
  });

  it('returns 400 for expected payload errors', async () => {
    const reply = buildReply();
    const req = {
      body: [{}],
      tenantModels: {},
      tenant: {},
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockSyncPrices.mockRejectedValue(new Error('lineItems must be a non-empty array'));

    await buildController().syncPrices(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(mockMarkAsError).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      message: 'lineItems must be a non-empty array',
    });
    expect(mockFinishSyncLog).toHaveBeenCalledWith(
      { _id: 'sync-log-1' },
      expect.objectContaining({
        status: 'errored',
      })
    );
  });

  it('skips duplicate webhook executions without calling the sync service', async () => {
    const reply = buildReply();
    const req = {
      body: [
        {
          associationType: 'DEAL_TO_LINE_ITEM',
          portalId: 50564010,
        },
      ],
      tenantModels: {
        LineItemPriceWebhookEvent: {},
      },
      tenant: { client: { hubspot: { portalId: '50564010' } } },
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockPreparePayload.mockResolvedValue({
      skip: true,
      payload: null,
      executionId: 'event-1',
      meta: {
        skipped: true,
        reason: 'duplicate_event',
      },
    });

    await buildController().syncPrices(req, reply);

    expect(mockSyncPrices).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({
      ok: true,
      data: null,
      meta: {
        skipped: true,
        reason: 'duplicate_event',
      },
    });
  });

  it('marks webhook execution as sent after processing the new payload format', async () => {
    const reply = buildReply();
    const req = {
      body: [
        {
          associationType: 'DEAL_TO_LINE_ITEM',
          portalId: 50564010,
          fromObjectId: 58986911596,
        },
      ],
      tenantModels: {
        LineItemPriceWebhookEvent: { name: 'LineItemPriceWebhookEvent' },
      },
      tenant: { client: { hubspot: { portalId: '50564010' } } },
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockPreparePayload.mockResolvedValue({
      skip: false,
      payload: {
        dealId: '58986911596',
        cardCode: 'CL00129',
        lineItems: [{ itemCode: 'A01050211', id: '54118822955', quantity: '0' }],
      },
      executionId: 'event-1',
    });
    mockSyncPrices.mockResolvedValue({
      data: {
        cardCode: 'CL00129',
        dealId: '58986911596',
        totalAmount: 10,
        lineItems: [{
          itemCode: 'A01050211',
          id: '54118822955',
          quantity: 1,
          Price: 10,
          lineTotal: 10,
        }],
      },
      meta: {
        requestedCount: 1,
        updatedCount: 1,
        dealUpdated: true,
      },
      audit: {
        dealId: '58986911596',
        rounds: [{ round: 1, failures: [{ id: 'line-3', stage: 'hubspot_read' }] }],
      },
    });

    await buildController().syncPrices(req, reply);

    expect(mockSyncPrices).toHaveBeenCalledWith(
      {
        dealId: '58986911596',
        cardCode: 'CL00129',
        lineItems: [{ itemCode: 'A01050211', id: '54118822955', quantity: '0' }],
      },
      {
        tenantModels: req.tenantModels,
        tenant: req.tenant,
        tenantKey: req.tenantKey,
      }
    );
    // El audit viaja hasta el evento: sin este tercer argumento, todo lo que capturaron las
    // rondas se queda en la respuesta HTTP y no queda nada persistido que explique el fallo
    // parcial de una línea.
    expect(mockMarkAsSent).toHaveBeenCalledWith(
      req.tenantModels.LineItemPriceWebhookEvent,
      'event-1',
      {
        dealId: '58986911596',
        rounds: [{ round: 1, failures: [{ id: 'line-3', stage: 'hubspot_read' }] }],
      }
    );
  });

  it('forwards the audit attached to the error when the sync fails', async () => {
    const reply = buildReply();
    const req = {
      body: [
        {
          associationType: 'DEAL_TO_LINE_ITEM',
          portalId: 50564010,
          fromObjectId: 58986911596,
        },
      ],
      tenantModels: {
        LineItemPriceWebhookEvent: { name: 'LineItemPriceWebhookEvent' },
      },
      tenant: { client: { hubspot: { portalId: '50564010' } } },
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockPreparePayload.mockResolvedValue({
      skip: false,
      payload: {
        dealId: '58986911596',
        cardCode: 'CL00129',
        lineItems: [{ itemCode: 'A01050211', id: '54118822955' }],
      },
      executionId: 'event-1',
    });

    const error = Object.assign(new Error('No line item prices could be resolved for this deal'), {
      lineItemPriceAudit: {
        dealId: '58986911596',
        fatalError: { message: 'No line item prices could be resolved for this deal', status: null },
      },
    });
    mockSyncPrices.mockRejectedValue(error);

    await buildController().syncPrices(req, reply);

    expect(mockMarkAsError).toHaveBeenCalledWith(
      req.tenantModels.LineItemPriceWebhookEvent,
      'event-1',
      error,
      {
        dealId: '58986911596',
        fatalError: { message: 'No line item prices could be resolved for this deal', status: null },
      }
    );
    expect(reply.code).toHaveBeenCalledWith(500);
  });

  it('marks the error with a null audit when the failure carries none', async () => {
    const reply = buildReply();
    const req = {
      body: [
        {
          associationType: 'DEAL_TO_LINE_ITEM',
          portalId: 50564010,
          fromObjectId: 58986911596,
        },
      ],
      tenantModels: {
        LineItemPriceWebhookEvent: { name: 'LineItemPriceWebhookEvent' },
      },
      tenant: { client: { hubspot: { portalId: '50564010' } } },
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockPreparePayload.mockResolvedValue({
      skip: false,
      payload: {
        dealId: '58986911596',
        lineItems: [{ itemCode: 'A01050211', id: '54118822955' }],
      },
      executionId: 'event-1',
    });

    const error = new Error('HubSpot batch update failed');
    mockSyncPrices.mockRejectedValue(error);

    await buildController().syncPrices(req, reply);

    // `null` explícito y no `undefined`: `markAsError` lo pasa a `persistAudit`, que sólo
    // omite la escritura si el valor es falsy, y un `undefined` implícito escondería si el
    // controlador realmente leyó el audit del error.
    expect(mockMarkAsError).toHaveBeenCalledWith(
      req.tenantModels.LineItemPriceWebhookEvent,
      'event-1',
      error,
      null
    );
  });
});
