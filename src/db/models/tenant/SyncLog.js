import mongoose from 'mongoose';

const { Schema } = mongoose;

export const syncLogSchema = new Schema(
  {
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
    },
    status: {
      type: String,
      enum: ['completed', 'errored'],
      default: null,
    },
    recordsProcessed: {
      type: Number,
      default: 0,
    },
    sent: {
      type: Number,
      default: 0,
    },
    failed: {
      type: Number,
      default: 0,
    },
    errorMessage: {
      type: Schema.Types.Mixed,
      default: null,
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

export function createSyncLogModel(connection) {
  return connection.models.SyncLog || connection.model('SyncLog', syncLogSchema);
}
