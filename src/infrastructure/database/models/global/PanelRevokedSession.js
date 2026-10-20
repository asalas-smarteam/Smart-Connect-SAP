import mongoose from 'mongoose';

const { Schema } = mongoose;

// Sesiones del panel cerradas con logout. Cada documento vive hasta que el token habría vencido
// de todas formas (TTL en expiresAt); después ya no hace falta recordarlo.
const panelRevokedSessionSchema = new Schema(
  {
    sid: { type: String, required: true, unique: true },
    userId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'PanelRevokedSessions',
    versionKey: false,
  }
);

panelRevokedSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PanelRevokedSession', panelRevokedSessionSchema);
