import mongoose from 'mongoose';

const { Schema } = mongoose;

export const webhookEventSchema = new Schema(
  {
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ['waiting', 'inprocess', 'completed', 'errored'],
      default: 'waiting',
      index: true,
    },
    retries: {
      type: Number,
      default: 0,
    },
    maxRetries: {
      type: Number,
      default: 3,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'WebhookEvents',
  }
);

webhookEventSchema.index(
  {
    eventType: 1,
    'payload.deal.hs_object_id': 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      eventType: 'createDeal',
      'payload.deal.hs_object_id': { $exists: true },
    },
  }
);

export function createWebhookEventModel(connection) {
  return connection.models.WebhookEvent
    || connection.model('WebhookEvent', webhookEventSchema);
}
