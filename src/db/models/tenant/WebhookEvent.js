import mongoose from 'mongoose';

const { Schema } = mongoose;

export const webhookEventSchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
      index: true,
    },
    objectType: {
      type: String,
      required: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'WebhookEvents',
  }
);

export function createWebhookEventModel(connection) {
  return connection.models.WebhookEvent
    || connection.model('WebhookEvent', webhookEventSchema);
}
