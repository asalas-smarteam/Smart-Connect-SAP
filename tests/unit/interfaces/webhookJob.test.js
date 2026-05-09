import { jest } from '@jest/globals';
import { createWebhookJobProcessor } from '../../../src/interfaces/jobs/webhook.job.js';

describe('webhook job processor', () => {
  it('passes webhook job payload to the tenant processor', async () => {
    const webhookTenantProcessor = jest.fn().mockResolvedValue({ ok: true });
    const processor = createWebhookJobProcessor({ webhookTenantProcessor });
    const job = {
      id: 'job-1',
      name: 'webhook-tenant-job',
      data: {
        tenantId: 'tenant-id',
        tenantKey: 'tenant-key',
        portalId: 'portal-id',
        triggerType: 'manual',
      },
    };

    await expect(processor(job)).resolves.toEqual({ ok: true });
    expect(webhookTenantProcessor).toHaveBeenCalledWith({
      tenantId: 'tenant-id',
      tenantKey: 'tenant-key',
      portalId: 'portal-id',
      triggerType: 'manual',
    });
  });

  it('requires tenant id', async () => {
    const processor = createWebhookJobProcessor({
      webhookTenantProcessor: jest.fn(),
    });

    await expect(processor({
      id: 'job-1',
      name: 'webhook-tenant-job',
      data: {},
    })).rejects.toThrow('tenantId is required in webhook job payload');
  });
});

