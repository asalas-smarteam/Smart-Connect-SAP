import HubspotCreateDealWebhook from '../../../src/domain/webhooks/HubspotCreateDealWebhook.js';

describe('HubspotCreateDealWebhook', () => {
  it('normalizes tenant, portal and deal identifiers from a webhook request', () => {
    const webhook = HubspotCreateDealWebhook.fromRequest({
      tenantId: ' tenant-1 ',
      payload: {
        portalId: 123,
        deal: { hs_object_id: ' deal-1 ' },
      },
    });

    expect(webhook.tenantId).toBe('tenant-1');
    expect(webhook.portalId).toBe('123');
    expect(webhook.dealId).toBe('deal-1');
    expect(() => webhook.validate()).not.toThrow();
  });

  it('rejects tenant portal mismatches', () => {
    const webhook = HubspotCreateDealWebhook.fromRequest({
      tenantId: 'tenant-1',
      payload: {
        portalId: '123',
        deal: { hs_object_id: 'deal-1' },
      },
    });

    expect(() => webhook.assertMatchesTenantPortal('999')).toThrow(
      'portalId does not match tenant'
    );
  });
});
