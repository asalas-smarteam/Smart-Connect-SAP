import mongoose from 'mongoose';

const { Schema } = mongoose;

const logEntrySchema = new Schema(
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

export default mongoose.model('LogEntry', logEntrySchema);
