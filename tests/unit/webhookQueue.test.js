import { buildWebhookTenantJobId } from '../../src/queues/webhook.queue.js';

describe('webhook.queue buildWebhookTenantJobId', () => {
  it('builds a BullMQ-safe deterministic job id', () => {
    expect(buildWebhookTenantJobId('tenant-1')).toBe('webhook-tenant-1');
  });

  it('encodes tenant ids that contain colons', () => {
    const jobId = buildWebhookTenantJobId('tenant:1');

    expect(jobId).toBe('webhook-tenant%3A1');
    expect(jobId).not.toContain(':');
  });
});
