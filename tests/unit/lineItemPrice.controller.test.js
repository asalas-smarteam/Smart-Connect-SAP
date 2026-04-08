import { jest } from '@jest/globals';

const mockSyncPrices = jest.fn();

jest.unstable_mockModule('../../src/services/lineItemPrice.service.js', () => ({
  default: {
    syncPrices: mockSyncPrices,
  },
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
  });

  it('returns the enriched payload and update summary', async () => {
    const reply = buildReply();
    const req = {
      body: {
        cardCode: 'C20000',
        lineItems: [{ itemCode: 'A0001', id: '53747313682' }],
      },
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
  });

  it('returns 400 for expected payload errors', async () => {
    const reply = buildReply();
    const req = {
      body: {},
      tenantModels: {},
      tenant: {},
      tenantKey: 'tenant_1',
      log: { error: jest.fn() },
    };

    mockSyncPrices.mockRejectedValue(new Error('cardCode is required'));

    await lineItemPriceController.syncPrices(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      message: 'cardCode is required',
    });
  });
});
