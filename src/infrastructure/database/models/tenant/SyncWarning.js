import mongoose from 'mongoose';

const { Schema } = mongoose;

export const syncWarningSchema = new Schema(
  {
    clientConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'ClientConfig',
      default: null,
    },
    syncLogId: {
      type: Schema.Types.ObjectId,
      ref: 'SyncLog',
      default: null,
    },
    objectType: {
      type: String,
      default: null,
    },
    // B1 identifies contacts with a numeric InternalCode; S/4 uses a string
    // BusinessPartner id.
    sapId: {
      type: Schema.Types.Mixed,
      default: null,
    },
    code: {
      type: String,
      default: null,
    },
    message: {
      type: String,
      default: null,
    },
    details: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    collection: 'SyncWarnings',
  }
);

export function createSyncWarningModel(connection) {
  return connection.models.SyncWarning || connection.model('SyncWarning', syncWarningSchema);
}
