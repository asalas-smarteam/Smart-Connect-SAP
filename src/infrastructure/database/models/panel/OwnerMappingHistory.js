import mongoose from 'mongoose';

const { Schema } = mongoose;

// Historial de cambios del mapeo de responsables hechos desde el panel (plan 12, contrato 14, O4),
// en la base de cada tenant (colección OwnerMappingHistory). Solo inserciones; sin TTL.
// autoIndex y autoCreate apagados, como Tickets: registrar el modelo no crea la colección ni la
// base. Los índices se crean con el primer documento (MongooseOwnerMappingWriter.appendHistory).
const changeSchema = new Schema(
  {
    field: { type: String, enum: ['erpOwnerId', 'erpEmployeeId'], required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
  },
  { _id: false }
);

export const ownerMappingHistorySchema = new Schema(
  {
    mappingId: { type: Schema.Types.ObjectId, required: true },
    crmOwnerId: { type: String, default: null },
    action: { type: String, enum: ['updated', 'synced_created'], required: true },
    changedBy: {
      userId: { type: String, default: null },
      name: { type: String, default: null },
      email: { type: String, default: null },
      accountType: { type: String, default: null },
    },
    changedAt: { type: Date, required: true },
    changes: { type: [changeSchema], default: [] },
  },
  {
    collection: 'OwnerMappingHistory',
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
  }
);

ownerMappingHistorySchema.index({ mappingId: 1, changedAt: -1 });
ownerMappingHistorySchema.index({ changedAt: -1 });

export function createOwnerMappingHistoryModel(connection) {
  return connection.models.PanelOwnerMappingHistory
    || connection.model('PanelOwnerMappingHistory', ownerMappingHistorySchema);
}
