import mongoose from 'mongoose';

const { Schema } = mongoose;

export const ownerMappingSchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    hubspotOwnerId: {
      type: String,
      required: true,
    },
    hubspotOwnerEmail: {
      type: String,
      default: null,
    },
    hubspotOwnerName: {
      type: String,
      default: null,
    },
    sapOwnerId: {
      type: String,
      default: null,
    },
    sapOwnerName: {
      type: String,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    source: {
      type: String,
      enum: ['hubspot_seed', 'manual'],
      default: 'hubspot_seed',
    },
  },
  {
    timestamps: true,
    collection: 'OwnerMappings',
  }
);

ownerMappingSchema.index(
  { hubspotCredentialId: 1, hubspotOwnerId: 1 },
  { unique: true, name: 'uniq_hubspot_owner_mapping' }
);

ownerMappingSchema.index(
  { hubspotCredentialId: 1, sapOwnerId: 1 },
  {
    unique: true,
    name: 'uniq_sap_owner_mapping_partial',
    partialFilterExpression: { sapOwnerId: { $type: 'string' } },
  }
);

export function createOwnerMappingModel(connection) {
  return (
    connection.models.OwnerMapping
    || connection.model('OwnerMapping', ownerMappingSchema)
  );
}
