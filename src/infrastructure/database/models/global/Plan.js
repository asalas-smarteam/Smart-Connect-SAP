import mongoose from 'mongoose';

const { Schema } = mongoose;

const planSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'USD',
    },
    features: {
      type: [String],
      default: [],
    },
    limits: {
      type: Schema.Types.Mixed,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    collection: 'Plans',
  }
);

export default mongoose.model('Plan', planSchema);
