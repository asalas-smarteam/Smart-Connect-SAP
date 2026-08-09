import { jest } from '@jest/globals';
import SapWebhookInventoryTransferRequestAdapter from '../../../src/infrastructure/sap/SapWebhookInventoryTransferRequestAdapter.js';

describe('SapWebhookInventoryTransferRequestAdapter', () => {
  it('posts to the relative /InventoryTransferRequests path', async () => {
    const adapter = new SapWebhookInventoryTransferRequestAdapter();
    adapter.request = jest.fn().mockResolvedValue({ DocEntry: 1, DocNum: 2 });

    const sapConfig = { serviceLayerBaseUrl: 'https://sap.test' };
    const inventoryTransferRequestPayload = { FromWarehouse: '01', ToWarehouse: '02' };

    const result = await adapter.createInventoryTransferRequest({
      sapConfig,
      inventoryTransferRequestPayload,
    });

    expect(adapter.request).toHaveBeenCalledWith(sapConfig, {
      method: 'post',
      path: '/InventoryTransferRequests',
      data: inventoryTransferRequestPayload,
    });
    expect(result).toEqual({ DocEntry: 1, DocNum: 2 });
  });
});
