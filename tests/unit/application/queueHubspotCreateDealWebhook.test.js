import { jest } from '@jest/globals';
import QueueHubspotCreateDealWebhook from '../../../src/application/use-cases/QueueHubspotCreateDealWebhook.js';

function createUseCase() {
  const activeTenantResolver = {
    resolve: jest.fn().mockResolvedValue({
      client: {
        _id: 'tenant-1',
        tenantKey: 'tenant_key_1',
        hubspot: { portalId: '123' },
      },
    }),
  };
  const webhookEventRepository = {
    queueCreateDealEvent: jest.fn().mockResolvedValue({
      duplicated: false,
      eventId: 'event-1',
    }),
  };
  const webhookQueue = {
    addManualJob: jest.fn(),
  };
  const logger = {
    info: jest.fn(),
  };

  return {
    useCase: new QueueHubspotCreateDealWebhook({
      activeTenantResolver,
      webhookEventRepository,
      webhookQueue,
      logger,
    }),
    activeTenantResolver,
    webhookEventRepository,
    webhookQueue,
  };
}

describe('QueueHubspotCreateDealWebhook', () => {
  it('queues a new create deal webhook event for the resolved active tenant', async () => {
    const {
      useCase,
      activeTenantResolver,
      webhookEventRepository,
      webhookQueue,
    } = createUseCase();
    const payload = {
      tenantId: 'tenant-1',
      portalId: '123',
      deal: { hs_object_id: 'deal-1' },
    };

    const result = await useCase.execute({ payload });

    expect(activeTenantResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(webhookEventRepository.queueCreateDealEvent).toHaveBeenCalledWith({
      tenantKey: 'tenant_key_1',
      payload,
    });
    expect(webhookQueue.addManualJob).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      tenantKey: 'tenant_key_1',
      portalId: '123',
      triggerType: 'webhook',
    });
    expect(result).toEqual({
      duplicated: false,
      message: 'Event queued',
    });
  });

  it('does not enqueue a worker job for duplicate webhook events', async () => {
    const {
      useCase,
      webhookEventRepository,
      webhookQueue,
    } = createUseCase();
    webhookEventRepository.queueCreateDealEvent.mockResolvedValue({
      duplicated: true,
      eventId: 'event-1',
    });

    const result = await useCase.execute({
      payload: {
        tenantId: 'tenant-1',
        portalId: '123',
        deal: { hs_object_id: 'deal-1' },
      },
    });

    expect(webhookQueue.addManualJob).not.toHaveBeenCalled();
    expect(result).toEqual({
      duplicated: true,
      message: 'Duplicate event ignored',
    });
  });

  it('rejects mismatched tenant portal ids', async () => {
    const { useCase } = createUseCase();

    await expect(
      useCase.execute({
        payload: {
          tenantId: 'tenant-1',
          portalId: '999',
          deal: { hs_object_id: 'deal-1' },
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'portalId does not match tenant',
    });
  });
});
