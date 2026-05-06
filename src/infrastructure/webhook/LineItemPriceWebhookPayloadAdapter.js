import lineItemPriceWebhookService from './lineItemPriceWebhook.service.js';

export class LineItemPriceWebhookPayloadAdapter {
  preparePayload(payload, context) {
    return lineItemPriceWebhookService.preparePayload(payload, context);
  }

  markAsSent(LineItemPriceWebhookEvent, executionId) {
    return lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, executionId);
  }

  markAsError(LineItemPriceWebhookEvent, executionId, error) {
    return lineItemPriceWebhookService.markAsError(LineItemPriceWebhookEvent, executionId, error);
  }
}

export const lineItemPriceWebhookPayloadAdapter = new LineItemPriceWebhookPayloadAdapter();

export default lineItemPriceWebhookPayloadAdapter;
