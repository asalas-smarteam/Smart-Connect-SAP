import mongoose from 'mongoose';

const { Schema } = mongoose;

const featureFlagSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    description: {
      type: String,
      default: null,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    allowedPlanIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: 'Plan',
        },
      ],
      default: [],
    },
  },
  {
    collection: 'FeatureFlags',
  }
);

export default mongoose.model('FeatureFlags', featureFlagSchema);
