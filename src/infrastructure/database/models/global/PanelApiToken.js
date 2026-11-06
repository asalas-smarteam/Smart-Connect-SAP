import mongoose from 'mongoose';
import { API_TOKEN_NAME_MAX, API_TOKEN_REVOKE_REASON_VALUES } from '#domain/panel/apiTokens.js';

const { Schema } = mongoose;

// Tokens personales del panel para cuentas de Smarteam (contrato 12, M2). Viven en la base
// master, junto a PanelUsers. Nunca se guarda el token en claro: solo su SHA-256 en hex
// (tokenHash) y los primeros 8 caracteres (prefix) para reconocerlo en la lista.
// El documento se borra solo (TTL en purgeAt) 30 días después de vencer o de revocarse.
const panelApiTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: API_TOKEN_NAME_MAX },
    tokenHash: { type: String, required: true },
    prefix: { type: String, required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: [...API_TOKEN_REVOKE_REASON_VALUES, null], default: null },
    purgeAt: { type: Date, required: true },
  },
  {
    collection: 'PanelApiTokens',
    versionKey: false,
  }
);

panelApiTokenSchema.index({ tokenHash: 1 }, { unique: true });
panelApiTokenSchema.index({ userId: 1, createdAt: -1 });
panelApiTokenSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PanelApiToken', panelApiTokenSchema);
