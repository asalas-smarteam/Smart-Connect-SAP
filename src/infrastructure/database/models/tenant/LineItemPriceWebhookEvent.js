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
    dealId: {
      type: String,
      default: null,
    },
    // El audit se escribe SIEMPRE en un $set aparte del de isSend/errorMessage: el Mongo de
    // producción es < 5.0 y rechaza el $set completo por una sola clave con `$` al inicio
    // (los params de OData traen `$select`), y con él se perdería el errorMessage.
    audit: {
      type: Schema.Types.Mixed,
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

lineItemPriceWebhookEventSchema.index({ dealId: 1, createdAt: -1 });

lineItemPriceWebhookEventSchema.index({
  'payload.objectId': 1,
  'payload.sourceId': 1,
  'payload.propertyValue': 1,
  'payload.occurredAt': 1,
});

export function createLineItemPriceWebhookEventModel(connection) {
  return connection.models.LineItemPriceWebhookEvent
    || connection.model('LineItemPriceWebhookEvent', lineItemPriceWebhookEventSchema);
}
