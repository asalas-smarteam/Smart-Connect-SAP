function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

// Base validation shared by every HubSpot deal-based webhook (createDeal and the
// quotation flows). They all carry the same base payload: { portalId, deal, ... }.
export class HubspotDealWebhook {
  constructor({ payload, tenantId, eventType = 'createDeal' }) {
    this.payload = payload;
    this.tenantId = tenantId;
    this.eventType = eventType;
    this.portalId = toNonEmptyString(payload?.portalId);
    this.dealId = toNonEmptyString(payload?.deal?.hs_object_id);
  }

  static fromRequest({ payload = {}, tenantId, eventType = 'createDeal' }) {
    return new this({
      payload,
      tenantId: toNonEmptyString(tenantId) || toNonEmptyString(payload?.tenantId),
      eventType,
    });
  }

  validate() {
    if (!this.portalId) {
      throw new Error('portalId is required');
    }

    if (!this.payload?.deal) {
      throw new Error('deal is required');
    }

    if (!this.dealId) {
      throw new Error('deal.hs_object_id is required');
    }

    if (!this.tenantId) {
      throw new Error('tenantId is required');
    }
  }

  assertMatchesTenantPortal(tenantPortalId) {
    const expectedPortalId = toNonEmptyString(tenantPortalId);
    if (expectedPortalId && expectedPortalId !== this.portalId) {
      throw new Error('portalId does not match tenant');
    }
  }
}

// Backwards-compatible alias kept for the existing createDeal flow.
export class HubspotCreateDealWebhook extends HubspotDealWebhook {}

export default HubspotCreateDealWebhook;
