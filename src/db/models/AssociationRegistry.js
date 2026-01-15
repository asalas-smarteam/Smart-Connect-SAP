import mongoose from 'mongoose';

const { Schema } = mongoose;

const associationRegistrySchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    baseObjectType: {
      type: String,
      required: true,
    },
    baseSapId: {
      type: String,
      required: true,
    },
    baseHubspotId: {
      type: String,
      required: true,
    },
    associatedObjectType: {
      type: String,
      default: null,
    },
    associatedSapId: {
      type: String,
      default: null,
    },
    associatedHubspotId: {
      type: String,
      default: null,
    },
    quantity: {
      type: Number,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    collection: 'AssociationRegistries',
  }
);

export default mongoose.model('AssociationRegistry', associationRegistrySchema);
