import { jest } from '@jest/globals';

const mockGetTenantModels = jest.fn();
const mockResolveActiveTenant = jest.fn();
const mockQueueCreateDealEvent = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule('../../src/config/tenantDatabase.js', () => ({
  getTenantModels: mockGetTenantModels,
}));

jest.unstable_mockModule('../../src/utils/tenantSubscriptions.js', () => ({
  resolveActiveTenant: mockResolveActiveTenant,
}));

jest.unstable_mockModule('../../src/services/webhookEvent.service.js', () => ({
  queueCreateDealEvent: mockQueueCreateDealEvent,
}));

jest.unstable_mockModule('../../src/core/logger.js', () => ({
  default: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

const { receiveHubspotWebhook } = await import('../../src/controllers/webhook.controller.js');

function buildReply() {
  return {
    code: jest.fn().mockReturnThis(),
    send: jest.fn((payload) => payload),
  };
}

describe('webhook.controller receiveHubspotWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when tenantId is missing', async () => {
    const req = {
      body: {
        portalId: '123',
        deal: { hs_object_id: '456' },
      },
    };
    const reply = buildReply();

    await receiveHubspotWebhook(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ success: false, message: 'tenantId is required' });
    expect(mockResolveActiveTenant).not.toHaveBeenCalled();
  });

  it('returns 400 when deal.hs_object_id is missing', async () => {
    const req = {
      body: {
        tenantId: 'tenant-1',
        portalId: '123',
        deal: {},
      },
    };
    const reply = buildReply();

    await receiveHubspotWebhook(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ success: false, message: 'deal.hs_object_id is required' });
  });

  it('queues event and returns success', async () => {
    const req = {
      body: {
        tenantId: 'tenant-1',
        portalId: '123',
        deal: { hs_object_id: '456' },
        company: { name: 'Acme' },
      },
    };

    const reply = buildReply();
    mockResolveActiveTenant.mockResolvedValue({
      client: {
        tenantKey: 'tenant_key_1',
        hubspot: { portalId: '123' },
      },
    });

    const WebhookEvent = {};
    mockGetTenantModels.mockResolvedValue({ WebhookEvent });
    mockQueueCreateDealEvent.mockResolvedValue({ duplicated: false, eventId: 'evt-1' });

    await receiveHubspotWebhook(req, reply);

    expect(mockResolveActiveTenant).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(mockGetTenantModels).toHaveBeenCalledWith('tenant_key_1');
    expect(mockQueueCreateDealEvent).toHaveBeenCalledWith({ WebhookEvent, payload: req.body });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ success: true, message: 'Event queued' });
  });

  it('returns success when duplicate event is detected', async () => {
    const req = {
      body: {
        tenantId: 'tenant-1',
        portalId: '123',
        deal: { hs_object_id: '456' },
      },
    };

    const reply = buildReply();
    mockResolveActiveTenant.mockResolvedValue({
      client: {
        tenantKey: 'tenant_key_1',
        hubspot: { portalId: '123' },
      },
    });

    mockGetTenantModels.mockResolvedValue({ WebhookEvent: {} });
    mockQueueCreateDealEvent.mockResolvedValue({ duplicated: true, eventId: 'evt-2' });

    await receiveHubspotWebhook(req, reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ success: true, message: 'Duplicate event ignored' });
  });
});
