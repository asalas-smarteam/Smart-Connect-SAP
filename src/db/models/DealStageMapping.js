import mongoose from 'mongoose';

const { Schema } = mongoose;

const dealStageMappingSchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    sapStageKey: {
      type: String,
      required: true,
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
  { hubspotCredentialId: 1, sapStageKey: 1, hubspotPipelineId: 1 },
  { unique: true, name: 'idx_unique_stage_mapping' }
);

export default mongoose.model('DealStageMapping', dealStageMappingSchema);
