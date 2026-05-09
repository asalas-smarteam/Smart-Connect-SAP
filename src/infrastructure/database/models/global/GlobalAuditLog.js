import mongoose from 'mongoose';

const { Schema } = mongoose;

const globalAuditLogSchema = new Schema(
  {
    actor: {
      type: String,
      default: null,
    },
    actorType: {
      type: String,
      default: null,
    },
    action: {
      type: String,
      required: true,
    },
    resourceType: {
      type: String,
      default: null,
    },
    resourceId: {
      type: String,
      default: null,
    },
    tenantKey: {
      type: String,
      default: null,
    },
    payload: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: 'GlobalAuditLogs',
  }
);

export default mongoose.model('GlobalAuditLog', globalAuditLogSchema);
