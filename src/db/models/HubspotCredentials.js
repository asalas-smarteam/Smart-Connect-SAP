import mongoose from 'mongoose';

const { Schema } = mongoose;

const hubspotCredentialsSchema = new Schema(
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

export default mongoose.model('HubspotCredentials', hubspotCredentialsSchema);
