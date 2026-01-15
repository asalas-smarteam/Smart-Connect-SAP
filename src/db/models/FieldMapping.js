import mongoose from 'mongoose';

const { Schema } = mongoose;

const fieldMappingSchema = new Schema(
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

export default mongoose.model('FieldMapping', fieldMappingSchema);
