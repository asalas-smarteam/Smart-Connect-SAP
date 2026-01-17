import mongoose from 'mongoose';

const { Schema } = mongoose;

export const dealOwnerMappingSchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    sapOwnerId: {
      type: String,
      required: true,
    },
    hubspotOwnerId: {
      type: String,
      required: true,
    },
    displayName: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: false,
    collection: 'DealOwnerMappings',
  }
);

dealOwnerMappingSchema.index(
  { hubspotCredentialId: 1, sapOwnerId: 1 },
  { unique: true, name: 'uniq_deal_owner_mapping' }
);

export function createDealOwnerMappingModel(connection) {
  return (
    connection.models.DealOwnerMapping
    || connection.model('DealOwnerMapping', dealOwnerMappingSchema)
  );
}
