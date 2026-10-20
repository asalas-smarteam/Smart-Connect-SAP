import mongoose from 'mongoose';

const { Schema } = mongoose;

// Ticket de soporte del panel, en la base de cada tenant (colección Tickets).
// autoIndex y autoCreate apagados: registrar el modelo para leer (bandeja de staff) no crea la
// colección ni la base. Los índices se crean con el primer ticket (MongooseTicketRepository).
const attachmentSchema = new Schema(
  {
    fileId: { type: Schema.Types.ObjectId, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

const messageSchema = new Schema(
  {
    authorType: { type: String, enum: ['cliente', 'smarteam', 'ia'], required: true },
    authorId: { type: String, default: null },
    authorName: { type: String, default: null },
    body: { type: String, required: true },
    attachments: { type: [attachmentSchema], default: [] },
    createdAt: { type: Date, required: true },
  },
  { _id: true }
);

const statusHistorySchema = new Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    byType: { type: String, required: true },
    byId: { type: String, default: null },
    byName: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { _id: false }
);

export const ticketSchema = new Schema(
  {
    number: { type: Number, required: true },
    code: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    category: { type: String, required: true },
    status: {
      type: String,
      enum: ['abierto', 'en_progreso', 'esperando_cliente', 'resuelto'],
      required: true,
    },
    context: {
      type: new Schema(
        {
          type: { type: String, enum: ['webhookEvent', 'syncLog'], required: true },
          refId: { type: String, required: true },
          snapshot: { type: Schema.Types.Mixed, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    createdBy: {
      userId: { type: String, default: null },
      name: { type: String, default: null },
      role: { type: String, default: null },
    },
    attachments: { type: [attachmentSchema], default: [] },
    messages: { type: [messageSchema], default: [] },
    internalResolution: {
      type: new Schema(
        {
          text: { type: String, required: true },
          updatedAt: { type: Date, required: true },
          updatedBy: {
            userId: { type: String, default: null },
            name: { type: String, default: null },
          },
        },
        { _id: false }
      ),
      default: null,
    },
    statusHistory: { type: [statusHistorySchema], default: [] },
    openedAt: { type: Date, required: true },
    firstResponseAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    reopenCount: { type: Number, default: 0 },
    lastActivityAt: { type: Date, required: true },
    lastPublicAuthorType: { type: String, default: null },
    clientLastSeenAt: { type: Date, default: null },
    staffLastSeenAt: { type: Date, default: null },
  },
  {
    collection: 'Tickets',
    timestamps: true,
    autoIndex: false,
    autoCreate: false,
  }
);

ticketSchema.index({ number: 1 }, { unique: true });
ticketSchema.index({ status: 1, lastActivityAt: -1 });
ticketSchema.index({ lastActivityAt: -1 });
ticketSchema.index({ category: 1, lastActivityAt: -1 });

export function createTicketModel(connection) {
  return connection.models.PanelTicket || connection.model('PanelTicket', ticketSchema);
}
