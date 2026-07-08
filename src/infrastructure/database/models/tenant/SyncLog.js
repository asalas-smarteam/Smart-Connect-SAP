import mongoose from 'mongoose';

const { Schema } = mongoose;

export const syncLogSchema = new Schema(
  {
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
    },
    objectType: {
      type: String,
      enum: ['Product', 'Contact', 'Deal', 'Company', 'Invoice'],
      default: null,
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
    errors: {
      type: [Schema.Types.Mixed],
      default: [],
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
