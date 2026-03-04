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
      default: null,
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
  { hubspotCredentialId: 1, hubspotPipelineId: 1 },
  { unique: true, name: 'uniq_hubspot_pipeline_mapping' }
);

dealPipelineMappingSchema.index(
  { hubspotCredentialId: 1, sapPipelineKey: 1 },
  {
    unique: true,
    partialFilterExpression: { sapPipelineKey: { $type: 'string' } },
    name: 'uniq_sap_pipeline_mapping_partial',
  }
);

export function createDealPipelineMappingModel(connection) {
  return (
    connection.models.DealPipelineMapping
    || connection.model('DealPipelineMapping', dealPipelineMappingSchema)
  );
}
