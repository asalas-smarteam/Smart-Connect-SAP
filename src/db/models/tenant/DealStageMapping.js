import mongoose from 'mongoose';

const { Schema } = mongoose;

export const dealStageMappingSchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    sapStageKey: {
      type: String,
      default: null,
    },
    hubspotStageId: {
      type: String,
      required: true,
    },
    hubspotStageLabel: {
      type: String,
      default: null,
    },
    hubspotPipelineId: {
      type: String,
      required: true,
    },
    dealPipelineMappingId: {
      type: Schema.Types.ObjectId,
      ref: 'DealPipelineMapping',
      default: null,
    },
    description: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'DealStageMappings',
  }
);

dealStageMappingSchema.index(
  { hubspotCredentialId: 1, hubspotPipelineId: 1, hubspotStageId: 1 },
  { unique: true, name: 'uniq_hubspot_stage_mapping' }
);

dealStageMappingSchema.index(
  { hubspotCredentialId: 1, hubspotPipelineId: 1, sapStageKey: 1 },
  {
    unique: true,
    partialFilterExpression: { sapStageKey: { $type: 'string' } },
    name: 'uniq_sap_stage_mapping_partial',
  }
);

export function createDealStageMappingModel(connection) {
  return (
    connection.models.DealStageMapping
    || connection.model('DealStageMapping', dealStageMappingSchema)
  );
}
