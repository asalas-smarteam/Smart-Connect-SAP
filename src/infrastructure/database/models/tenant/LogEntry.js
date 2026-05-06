import mongoose from 'mongoose';

const { Schema } = mongoose;

export const logEntrySchema = new Schema(
  {
    type: {
      type: String,
    },
    payload: {
      type: Schema.Types.Mixed,
    },
    level: {
      type: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    collection: 'LogEntries',
  }
);

export function createLogEntryModel(connection) {
  return connection.models.LogEntry || connection.model('LogEntry', logEntrySchema);
}
