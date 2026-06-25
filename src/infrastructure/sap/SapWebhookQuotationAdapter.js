import { sapServiceLayerWebhookRequest } from './sapServiceLayerWebhookRequest.js';

export class SapWebhookQuotationAdapter {
  async request(sapConfig, options) {
    return sapServiceLayerWebhookRequest(sapConfig, options);
  }

  async createQuotation({ sapConfig, quotationPayload }) {
    return this.request(sapConfig, {
      method: 'post',
      path: '/Quotations',
      data: quotationPayload,
    });
  }

  async getQuotation({ sapConfig, docEntry }) {
    return this.request(sapConfig, {
      method: 'get',
      path: `/Quotations(${encodeURIComponent(String(docEntry))})`,
    });
  }

  async updateQuotation({ sapConfig, docEntry, patchPayload }) {
    return this.request(sapConfig, {
      method: 'patch',
      path: `/Quotations(${encodeURIComponent(String(docEntry))})`,
      data: patchPayload,
    });
  }
}

export default SapWebhookQuotationAdapter;
