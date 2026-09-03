import { jest } from '@jest/globals';
import { buildWebhookEventDispatcher } from '../../../src/composition/webhook-processing.composition.js';

function stub() {
  return { execute: jest.fn().mockResolvedValue({ ok: true }) };
}

describe('buildWebhookEventDispatcher', () => {
  it('routes each eventType to its matching use case', async () => {
    const processHubspotWebhookEvent = stub();
    const processHubspotCreateQuotation = stub();
    const processHubspotUpdateQuotation = stub();
    const processHubspotConvertQuotationToOrder = stub();
    const processHubspotInventoryTransferRequest = stub();
    const processHubspotPurchaseQuotation = stub();

    const dispatch = buildWebhookEventDispatcher({
      processHubspotWebhookEvent,
      processHubspotCreateQuotation,
      processHubspotUpdateQuotation,
      processHubspotConvertQuotationToOrder,
      processHubspotInventoryTransferRequest,
      processHubspotPurchaseQuotation,
    });

    await dispatch({ event: { eventType: 'createDeal' } });
    await dispatch({ event: { eventType: 'createQuotation' } });
    await dispatch({ event: { eventType: 'updateQuotation' } });
    await dispatch({ event: { eventType: 'convertQuotationToOrder' } });
    await dispatch({ event: { eventType: 'inventoryTransferRequest' } });
    await dispatch({ event: { eventType: 'purchaseQuotation' } });

    expect(processHubspotWebhookEvent.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotCreateQuotation.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotUpdateQuotation.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotConvertQuotationToOrder.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotInventoryTransferRequest.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotPurchaseQuotation.execute).toHaveBeenCalledTimes(1);
  });

  it('falls back to the createDeal flow when eventType is absent (legacy events)', async () => {
    const processHubspotWebhookEvent = stub();
    const dispatch = buildWebhookEventDispatcher({
      processHubspotWebhookEvent,
      processHubspotCreateQuotation: stub(),
      processHubspotUpdateQuotation: stub(),
      processHubspotConvertQuotationToOrder: stub(),
      processHubspotInventoryTransferRequest: stub(),
      processHubspotPurchaseQuotation: stub(),
    });

    await dispatch({ event: {} });

    expect(processHubspotWebhookEvent.execute).toHaveBeenCalledTimes(1);
  });

  it('fails permanently instead of falling back for an unrecognized eventType', async () => {
    const processHubspotWebhookEvent = stub();
    const dispatch = buildWebhookEventDispatcher({
      processHubspotWebhookEvent,
      processHubspotCreateQuotation: stub(),
      processHubspotUpdateQuotation: stub(),
      processHubspotConvertQuotationToOrder: stub(),
      processHubspotInventoryTransferRequest: stub(),
      processHubspotPurchaseQuotation: stub(),
    });

    await expect(dispatch({ event: { eventType: 'somethingElse' } })).rejects.toMatchObject({
      permanent: true,
    });
    expect(processHubspotWebhookEvent.execute).not.toHaveBeenCalled();
  });
});
