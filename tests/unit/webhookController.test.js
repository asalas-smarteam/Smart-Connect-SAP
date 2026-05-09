import { jest } from '@jest/globals';
import { ApplicationError } from '../../src/shared/errors/index.js';
import { createWebhookController } from '../../src/interfaces/http/controllers/webhook.controller.js';

const mockExecute = jest.fn();
const mockLoggerError = jest.fn();

function buildReply() {
  return {
    code: jest.fn().mockReturnThis(),
    send: jest.fn((payload) => payload),
  };
}

function buildController() {
  return createWebhookController({
    queueHubspotCreateDealWebhook: {
      execute: mockExecute,
    },
    logger: {
      error: mockLoggerError,
    },
  });
}

describe('webhook.controller receiveHubspotWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the use case validation status when tenantId is missing', async () => {
    mockExecute.mockRejectedValue(new ApplicationError('tenantId is required', {
      statusCode: 400,
    }));

    const req = {
      body: {
        portalId: '123',
        deal: { hs_object_id: '456' },
      },
      headers: {},
    };
    const reply = buildReply();

    await buildController()(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ success: false, message: 'tenantId is required' });
    expect(mockExecute).toHaveBeenCalledWith({
      payload: req.body,
      tenantId: undefined,
    });
  });

  it('returns the use case validation status when deal.hs_object_id is missing', async () => {
    mockExecute.mockRejectedValue(new ApplicationError('deal.hs_object_id is required', {
      statusCode: 400,
    }));

    const req = {
      body: {
        tenantId: 'tenant-1',
        portalId: '123',
        deal: {},
      },
      headers: {},
    };
    const reply = buildReply();

    await buildController()(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ success: false, message: 'deal.hs_object_id is required' });
  });

  it('queues event and returns success', async () => {
    mockExecute.mockResolvedValue({ duplicated: false, message: 'Event queued' });

    const req = {
      body: {
        tenantId: 'tenant-1',
        portalId: '123',
        deal: { hs_object_id: '456' },
        company: { name: 'Acme' },
      },
      headers: {},
    };

    const reply = buildReply();

    await buildController()(req, reply);

    expect(mockExecute).toHaveBeenCalledWith({
      payload: req.body,
      tenantId: 'tenant-1',
    });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ success: true, message: 'Event queued' });
  });

  it('returns success when duplicate event is detected', async () => {
    mockExecute.mockResolvedValue({ duplicated: true, message: 'Duplicate event ignored' });

    const req = {
      body: {
        tenantId: 'tenant-1',
        portalId: '123',
        deal: { hs_object_id: '456' },
      },
      headers: {},
    };

    const reply = buildReply();

    await buildController()(req, reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ success: true, message: 'Duplicate event ignored' });
  });
});
