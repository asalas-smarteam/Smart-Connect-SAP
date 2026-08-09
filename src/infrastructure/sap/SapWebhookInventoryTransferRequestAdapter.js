import { sapServiceLayerWebhookRequest } from './sapServiceLayerWebhookRequest.js';

export class SapWebhookInventoryTransferRequestAdapter {
  async request(sapConfig, options) {
    return sapServiceLayerWebhookRequest(sapConfig, options);
  }

  async createInventoryTransferRequest({ sapConfig, inventoryTransferRequestPayload }) {
    return this.request(sapConfig, {
      method: 'post',
      path: '/InventoryTransferRequests',
      data: inventoryTransferRequestPayload,
    });
  }
}

export default SapWebhookInventoryTransferRequestAdapter;
