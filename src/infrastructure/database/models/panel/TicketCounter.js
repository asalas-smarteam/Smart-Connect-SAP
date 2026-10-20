import mongoose from 'mongoose';

const { Schema } = mongoose;

// Correlativo de tickets por tenant (colección TicketCounters): un documento { _id: 'tickets', seq }.
export const ticketCounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  {
    collection: 'TicketCounters',
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
  }
);

export function createTicketCounterModel(connection) {
  return connection.models.PanelTicketCounter
    || connection.model('PanelTicketCounter', ticketCounterSchema);
}
