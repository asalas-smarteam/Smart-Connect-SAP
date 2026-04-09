import mongoose from 'mongoose';

const { Schema } = mongoose;

export const lineItemPriceWebhookEventSchema = new Schema(
  {
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    isSend: {
      type: Boolean,
      default: false,
      index: true,
    },
    errorMessage: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'LineItemPriceWebhookEvents',
  }
);

lineItemPriceWebhookEventSchema.index(
  {
    'payload.eventId': 1,
    'payload.subscriptionId': 1,
    'payload.portalId': 1,
    'payload.appId': 1,
    'payload.occurredAt': 1,
    'payload.fromObjectId': 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      'payload.eventId': { $exists: true },
      'payload.subscriptionId': { $exists: true },
      'payload.portalId': { $exists: true },
      'payload.appId': { $exists: true },
      'payload.occurredAt': { $exists: true },
      'payload.fromObjectId': { $exists: true },
    },
  }
);

export function createLineItemPriceWebhookEventModel(connection) {
  return connection.models.LineItemPriceWebhookEvent
    || connection.model('LineItemPriceWebhookEvent', lineItemPriceWebhookEventSchema);
}
