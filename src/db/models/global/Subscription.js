import mongoose from 'mongoose';

const { Schema } = mongoose;

const subscriptionSchema = new Schema(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: 'SaaSClient',
      required: true,
    },
    planId: {
      type: Schema.Types.ObjectId,
      ref: 'Plan',
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'past_due', 'canceled', 'trial'],
      default: 'trial',
    },
    paymentStatus: {
      type: String,
      enum: ['paid', 'unpaid', 'pending'],
      default: 'pending',
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    currentPeriodEnd: {
      type: Date,
      default: null,
    },
    canceledAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  {
    collection: 'Subscriptions',
  }
);

subscriptionSchema.index({ clientId: 1, status: 1 });

export default mongoose.model('Subscription', subscriptionSchema);
