import mongoose from 'mongoose';

const { Schema } = mongoose;

export const fieldMappingSchema = new Schema(
  {
    sourceField: {
      type: String,
    },
    targetField: {
      type: String,
    },
    objectType: {
      type: String,
    },
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
    },
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: false,
    collection: 'FieldMappings',
  }
);

export function createFieldMappingModel(connection) {
  return connection.models.FieldMapping || connection.model('FieldMapping', fieldMappingSchema);
}
