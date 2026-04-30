import { jest } from '@jest/globals';
import {
  buildWebhookTenantJobId,
  removeReplaceableWebhookTenantJob,
} from '../../src/queues/webhook.queue.js';

describe('webhook.queue buildWebhookTenantJobId', () => {
  it('builds a BullMQ-safe deterministic job id', () => {
    expect(buildWebhookTenantJobId('tenant-1')).toBe('webhook-tenant-1');
  });

  it('encodes tenant ids that contain colons', () => {
    const jobId = buildWebhookTenantJobId('tenant:1');

    expect(jobId).toBe('webhook-tenant%3A1');
    expect(jobId).not.toContain(':');
  });

  it('removes completed tenant jobs so new webhook events can be enqueued', async () => {
    const remove = jest.fn().mockResolvedValue();
    const queue = {
      getJob: jest.fn().mockResolvedValue({
        getState: jest.fn().mockResolvedValue('completed'),
        remove,
      }),
    };

    const result = await removeReplaceableWebhookTenantJob(queue, 'webhook-tenant-1');

    expect(queue.getJob).toHaveBeenCalledWith('webhook-tenant-1');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ removed: true, state: 'completed' });
  });

  it('keeps active tenant jobs so processing stays coalesced', async () => {
    const remove = jest.fn().mockResolvedValue();
    const queue = {
      getJob: jest.fn().mockResolvedValue({
        getState: jest.fn().mockResolvedValue('active'),
        remove,
      }),
    };

    const result = await removeReplaceableWebhookTenantJob(queue, 'webhook-tenant-1');

    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: false, state: 'active' });
  });
});
