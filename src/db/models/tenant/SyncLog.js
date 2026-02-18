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

export function createSyncLogModel(connection) {
  return connection.models.SyncLog || connection.model('SyncLog', syncLogSchema);
}
