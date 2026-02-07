import mongoose from 'mongoose';

const { Schema } = mongoose;

export const webhookConfigSchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
      index: true,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    enabledObjectTypes: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'WebhookConfigs',
  }
);

export function createWebhookConfigModel(connection) {
  return connection.models.WebhookConfig
    || connection.model('WebhookConfig', webhookConfigSchema);
}
