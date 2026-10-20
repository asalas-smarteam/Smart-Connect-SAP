import mongoose from 'mongoose';
import { AUDIT_ACTIONS, AUDIT_SOURCES } from '#domain/panel/auditActions.js';

const { Schema } = mongoose;

const personSchema = new Schema(
  {
    userId: { type: String, default: null },
    email: { type: String, default: null, maxlength: 254 },
    accountType: { type: String, default: null },
    tenantKey: { type: String, default: null },
  },
  { _id: false }
);

// Registro de auditoría del panel de soporte: quién creó, editó, desactivó o restableció a cada
// usuario, y los eventos de acceso. Nunca guarda contraseñas, temporales, hashes, tokens ni
// cookies. Los eventos auth.* llevan expiresAt y el índice TTL los borra solos.
const panelAuditLogSchema = new Schema(
  {
    at: { type: Date, required: true },
    action: { type: String, enum: Object.values(AUDIT_ACTIONS), required: true },
    source: { type: String, enum: Object.values(AUDIT_SOURCES), default: AUDIT_SOURCES.PANEL },
    actor: { type: personSchema, default: null },
    target: { type: personSchema, default: null },
    details: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  {
    collection: 'PanelAuditLogs',
    versionKey: false,
  }
);

panelAuditLogSchema.index({ at: -1 });
panelAuditLogSchema.index({ 'target.userId': 1, at: -1 });
panelAuditLogSchema.index({ action: 1, at: -1 });
panelAuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PanelAuditLog', panelAuditLogSchema);
