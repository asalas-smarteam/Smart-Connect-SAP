import { jest } from '@jest/globals';

const mockSyncPrices = jest.fn();
const mockPreparePayload = jest.fn();
const mockMarkAsSent = jest.fn();
const mockMarkAsError = jest.fn();
const mockStartSyncLog = jest.fn();
const mockFinishSyncLog = jest.fn();

jest.unstable_mockModule('../../src/services/lineItemPrice.service.js', () => ({
  default: {
    syncPrices: mockSyncPrices,
  },
}));

jest.unstable_mockModule('../../src/services/lineItemPriceWebhook.service.js', () => ({
  default: {
    preparePayload: mockPreparePayload,
    markAsSent: mockMarkAsSent,
    markAsError: mockMarkAsError,
  },
}));

jest.unstable_mockModule('../../src/services/syncLog.service.js', () => ({
  buildErrorResponseSnapshot: jest.fn((error) => ({ message: error.message })),
  buildWebhookSyncErrorEntry: jest.fn((value) => value),
  finishSyncLog: mockFinishSyncLog,
  startSyncLog: mockStartSyncLog,
}));

const lineItemPriceController = (await import('../../src/controllers/lineItemPrice.controller.js')).default;

function buildReply() {
  return {
    code: jest.fn().mockReturnThis(),
    send: jest.fn((payload) => payload),
  };
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
        lineItems: [
          {
            itemCode: 'A0001',
            id: '53747313682',
            Price: 704.35,
            Currency: 'C$',
            Discount: 0.0,
          },
        ],
      },
      meta: {
        requestedCount: 1,
        updatedCount: 1,
      },
    });

    await lineItemPriceController.syncPrices(req, reply);

    expect(mockPreparePayload).toHaveBeenCalledWith(req.body[0], {
      tenantModels: req.tenantModels,
      tenant: req.tenant,
    });
    expect(reply.send).toHaveBeenCalledWith({
      ok: true,
      data: {
        cardCode: 'C20000',
        lineItems: [
          {
            itemCode: 'A0001',
            id: '53747313682',
            Price: 704.35,
            Currency: 'C$',
            Discount: 0.0,
          },
        ],
      },
      meta: {
        requestedCount: 1,
        updatedCount: 1,
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

  it('returns 400 for expected payload errors', async () => {
    const reply = buildReply();
    const req = {
      body: [{}],
      tenantModels: {},
      tenant: {},
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockSyncPrices.mockRejectedValue(new Error('cardCode is required'));

    await lineItemPriceController.syncPrices(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(mockMarkAsError).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      message: 'cardCode is required',
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

    await lineItemPriceController.syncPrices(req, reply);

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
        cardCode: 'CL00129',
        lineItems: [{ itemCode: 'A01050211', id: '54118822955' }],
      },
      executionId: 'event-1',
    });
    mockSyncPrices.mockResolvedValue({
      data: {
        cardCode: 'CL00129',
        lineItems: [{ itemCode: 'A01050211', id: '54118822955', Price: 10 }],
      },
      meta: {
        requestedCount: 1,
        updatedCount: 1,
      },
    });

    await lineItemPriceController.syncPrices(req, reply);

    expect(mockSyncPrices).toHaveBeenCalledWith(
      {
        cardCode: 'CL00129',
        lineItems: [{ itemCode: 'A01050211', id: '54118822955' }],
      },
      {
        tenantModels: req.tenantModels,
        tenant: req.tenant,
        tenantKey: req.tenantKey,
      }
    );
    expect(mockMarkAsSent).toHaveBeenCalledWith(
      req.tenantModels.LineItemPriceWebhookEvent,
      'event-1'
    );
  });
});
