import { sapServiceLayerWebhookRequest } from './sapServiceLayerWebhookRequest.js';

export class SapWebhookPurchaseQuotationAdapter {
  async request(sapConfig, options) {
    return sapServiceLayerWebhookRequest(sapConfig, options);
  }

  async createPurchaseQuotation({ sapConfig, purchaseQuotationPayload }) {
    return this.request(sapConfig, {
      method: 'post',
      path: '/PurchaseQuotations',
      data: purchaseQuotationPayload,
    });
  }
}

export default SapWebhookPurchaseQuotationAdapter;
