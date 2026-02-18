import mongoose from 'mongoose';

const { Schema } = mongoose;

const paymentStatusSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
    },
    label: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    collection: 'PaymentStatuses',
  }
);

export default mongoose.model('PaymentStatus', paymentStatusSchema);
