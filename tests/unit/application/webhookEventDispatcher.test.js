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

    const dispatch = buildWebhookEventDispatcher({
      processHubspotWebhookEvent,
      processHubspotCreateQuotation,
      processHubspotUpdateQuotation,
      processHubspotConvertQuotationToOrder,
    });

    await dispatch({ event: { eventType: 'createDeal' } });
    await dispatch({ event: { eventType: 'createQuotation' } });
    await dispatch({ event: { eventType: 'updateQuotation' } });
    await dispatch({ event: { eventType: 'convertQuotationToOrder' } });

    expect(processHubspotWebhookEvent.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotCreateQuotation.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotUpdateQuotation.execute).toHaveBeenCalledTimes(1);
    expect(processHubspotConvertQuotationToOrder.execute).toHaveBeenCalledTimes(1);
  });

  it('falls back to the createDeal flow for unknown event types', async () => {
    const processHubspotWebhookEvent = stub();
    const dispatch = buildWebhookEventDispatcher({
      processHubspotWebhookEvent,
      processHubspotCreateQuotation: stub(),
      processHubspotUpdateQuotation: stub(),
      processHubspotConvertQuotationToOrder: stub(),
    });

    await dispatch({ event: { eventType: 'somethingElse' } });
    await dispatch({ event: {} });

    expect(processHubspotWebhookEvent.execute).toHaveBeenCalledTimes(2);
  });
});
