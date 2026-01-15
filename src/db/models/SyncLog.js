import mongoose from 'mongoose';

const { Schema } = mongoose;

const syncLogSchema = new Schema(
  {
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
    },
    status: {
      type: String,
    },
    recordsProcessed: {
      type: Number,
    },
    sent: {
      type: Number,
    },
    failed: {
      type: Number,
    },
    errorMessage: {
      type: String,
    },
    startedAt: {
      type: Date,
    },
    finishedAt: {
      type: Date,
    },
  },
  {
    timestamps: false,
    collection: 'SyncLogs',
  }
);

export default mongoose.model('SyncLog', syncLogSchema);
