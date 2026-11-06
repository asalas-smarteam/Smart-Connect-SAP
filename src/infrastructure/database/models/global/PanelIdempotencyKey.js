import mongoose from 'mongoose';

const { Schema } = mongoose;

// Claves Idempotency-Key del registro de trabajo (contrato 12, M5). Viven en la base master.
// Guardan solo lo necesario para reconocer la clave y encontrar la entrada del ticket: nunca el
// resumen, la nota interna ni el cuerpo de la respuesta. TTL en expiresAt (24 h desde la primera
// reserva).
const panelIdempotencyKeySchema = new Schema(
  {
    ownerKey: { type: String, required: true }, // 'token:<id>' o 'user:<id>'
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    state: { type: String, enum: ['pending', 'done'], required: true },
    tenantKey: { type: String, default: null },
    ticketId: { type: String, default: null },
    entryId: { type: String, default: null },
    status: { type: Number, default: null },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'PanelIdempotencyKeys',
    versionKey: false,
  }
);

panelIdempotencyKeySchema.index({ ownerKey: 1, key: 1 }, { unique: true });
panelIdempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PanelIdempotencyKey', panelIdempotencyKeySchema);
