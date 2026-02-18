import mongoose from 'mongoose';

const { Schema } = mongoose;

export const dealPipelineMappingSchema = new Schema(
  {
    hubspotPipelineId: {
      type: String,
      required: true,
    },
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    sapPipelineKey: {
      type: String,
      required: true,
    },
    hubspotPipelineLabel: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'DealPipelineMappings',
  }
);

dealPipelineMappingSchema.index(
  { hubspotCredentialId: 1, sapPipelineKey: 1 },
  { unique: true, name: 'idx_unique_pipeline_mapping' }
);

export function createDealPipelineMappingModel(connection) {
  return (
    connection.models.DealPipelineMapping
    || connection.model('DealPipelineMapping', dealPipelineMappingSchema)
  );
}
