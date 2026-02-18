import mongoose from 'mongoose';

const { Schema } = mongoose;

export const hubspotCredentialsSchema = new Schema(
  {
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
    },
    portalId: {
      type: String,
    },
    accessToken: {
      type: String,
    },
    refreshToken: {
      type: String,
    },
    expiresAt: {
      type: Date,
    },
    scope: {
      type: String,
    },
  },
  {
    timestamps: false,
    collection: 'HubspotCredentials',
  }
);

export function createHubspotCredentialsModel(connection) {
  return (
    connection.models.HubspotCredentials
    || connection.model('HubspotCredentials', hubspotCredentialsSchema)
  );
}
