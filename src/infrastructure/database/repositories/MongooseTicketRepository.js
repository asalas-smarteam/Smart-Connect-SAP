import mongoose from 'mongoose';
import { getPanelTenantModels } from './panelTenantModels.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const COUNTER_ID = 'tickets';

// Campos de la lista: sin mensajes, historial, descripción, adjuntos, nota interna ni snapshot.
const LIST_PROJECTION = Object.freeze({
  number: 1,
  code: 1,
  title: 1,
  category: 1,
  status: 1,
  'context.type': 1,
  createdBy: 1,
  openedAt: 1,
  firstResponseAt: 1,
  resolvedAt: 1,
  reopenCount: 1,
  lastActivityAt: 1,
  lastPublicAuthorType: 1,
  clientLastSeenAt: 1,
  staffLastSeenAt: 1,
});

const SEEN_FIELD = Object.freeze({
  cliente: 'clientLastSeenAt',
  smarteam: 'staffLastSeenAt',
});

function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

function idOf(value) {
  return value === undefined || value === null ? null : String(value);
}

function toAttachment(attachment) {
  return {
    fileId: idOf(attachment.fileId),
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
  };
}

// Documento lean → ticket plano con ids en texto (sin _id ni __v).
function toTicket(document) {
  if (!document) {
    return null;
  }

  return {
    id: idOf(document._id),
    number: document.number,
    code: document.code,
    title: document.title,
    description: document.description ?? null,
    category: document.category,
    status: document.status,
    context: document.context
      ? {
        type: document.context.type,
        refId: document.context.refId ?? null,
        snapshot: document.context.snapshot ?? null,
      }
      : null,
    createdBy: {
      userId: document.createdBy?.userId ?? null,
      name: document.createdBy?.name ?? null,
      role: document.createdBy?.role ?? null,
    },
    attachments: (document.attachments ?? []).map(toAttachment),
    messages: (document.messages ?? []).map((message) => ({
      id: idOf(message._id),
      authorType: message.authorType,
      authorId: message.authorId ?? null,
      authorName: message.authorName ?? null,
      body: message.body,
      attachments: (message.attachments ?? []).map(toAttachment),
      createdAt: message.createdAt,
    })),
    internalResolution: document.internalResolution
      ? {
        text: document.internalResolution.text,
        updatedAt: document.internalResolution.updatedAt,
        updatedBy: {
          userId: document.internalResolution.updatedBy?.userId ?? null,
          name: document.internalResolution.updatedBy?.name ?? null,
        },
      }
      : null,
    statusHistory: (document.statusHistory ?? []).map((entry) => ({
      from: entry.from ?? null,
      to: entry.to,
      byType: entry.byType,
      byId: entry.byId ?? null,
      byName: entry.byName ?? null,
      at: entry.at,
    })),
    openedAt: document.openedAt,
    firstResponseAt: document.firstResponseAt ?? null,
    resolvedAt: document.resolvedAt ?? null,
    reopenCount: document.reopenCount ?? 0,
    lastActivityAt: document.lastActivityAt,
    lastPublicAuthorType: document.lastPublicAuthorType ?? null,
    clientLastSeenAt: document.clientLastSeenAt ?? null,
    staffLastSeenAt: document.staffLastSeenAt ?? null,
  };
}

function toMessageDocument(message) {
  const { id, ...rest } = message;
  return { _id: id, ...rest };
}

function listFilter({ status, category } = {}) {
  const filter = {};
  if (status) {
    filter.status = String(status);
  }
  if (category) {
    filter.category = String(category);
  }
  return filter;
}

// Tickets del panel en la base de cada tenant (ver panelTenantModels.js).
export class MongooseTicketRepository {
  constructor({ getModels = getPanelTenantModels } = {}) {
    this.getModels = getModels;
    this.indexesReady = new Map();
  }

  newId() {
    return new mongoose.Types.ObjectId().toString();
  }

  // Índices y colección se crean con el primer ticket del tenant, no al leer.
  async ensureIndexes(tenantKey, Ticket) {
    if (!this.indexesReady.has(tenantKey)) {
      const pending = Ticket.createIndexes().catch((error) => {
        this.indexesReady.delete(tenantKey);
        throw error;
      });
      this.indexesReady.set(tenantKey, pending);
    }
    await this.indexesReady.get(tenantKey);
  }

  async create(tenantKey, ticket, { codeFor }) {
    const { Ticket, TicketCounter } = await this.getModels(tenantKey);
    await this.ensureIndexes(tenantKey, Ticket);

    const counter = await TicketCounter.findOneAndUpdate(
      { _id: COUNTER_ID },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, lean: true }
    );
    const number = counter.seq;
    const { id, messages = [], ...fields } = ticket;

    const created = await Ticket.create({
      _id: id,
      ...fields,
      messages: messages.map(toMessageDocument),
      number,
      code: codeFor(number),
    });
    return toTicket(created.toObject());
  }

  async findById(tenantKey, id) {
    if (!isObjectId(id)) {
      return null;
    }
    const { Ticket } = await this.getModels(tenantKey);
    return toTicket(await Ticket.findById(id).lean());
  }

  async list(tenantKey, { status, category, skip = 0, limit = 25 } = {}) {
    const { Ticket } = await this.getModels(tenantKey);
    const filter = listFilter({ status, category });
    const [documents, total] = await Promise.all([
      Ticket.find(filter)
        .select(LIST_PROJECTION)
        .sort({ lastActivityAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Ticket.countDocuments(filter),
    ]);
    return { items: documents.map(toTicket), total };
  }

  async countByStatus(tenantKey) {
    const { Ticket } = await this.getModels(tenantKey);
    const rows = await Ticket.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  }

  // change: { expectedStatus, set, inc, pushMessage, pushHistory, setIfNull }.
  // El estado esperado funciona como compare-and-set: si otro request cambió el estado en el
  // medio, no se escribe nada y se devuelve null.
  async update(tenantKey, id, change) {
    if (!isObjectId(id)) {
      return null;
    }
    const { Ticket } = await this.getModels(tenantKey);
    const operations = {};
    if (change.set && Object.keys(change.set).length > 0) {
      operations.$set = { ...change.set };
    }
    if (change.inc) {
      operations.$inc = { ...change.inc };
    }
    const push = {};
    if (change.pushMessage) {
      push.messages = toMessageDocument(change.pushMessage);
    }
    if (change.pushHistory?.length) {
      push.statusHistory = { $each: change.pushHistory };
    }
    if (Object.keys(push).length > 0) {
      operations.$push = push;
    }

    const updated = await Ticket.findOneAndUpdate(
      { _id: id, status: change.expectedStatus },
      operations,
      { new: true, lean: true, runValidators: true }
    );
    if (!updated) {
      return null;
    }

    // "Solo si está vacío" (por ejemplo firstResponseAt) va aparte para no pisar un valor que
    // otro request haya escrito antes.
    const setIfNull = Object.entries(change.setIfNull ?? {});
    if (setIfNull.length === 0) {
      return toTicket(updated);
    }
    // El cambio principal ya quedó guardado: si esto falla, se devuelve lo guardado y no se
    // lanza (quien llama borraría las imágenes de un mensaje que ya existe).
    try {
      for (const [field, value] of setIfNull) {
        await Ticket.updateOne({ _id: id, [field]: null }, { $set: { [field]: value } });
      }
      return toTicket(await Ticket.findById(id).lean()) ?? toTicket(updated);
    } catch (error) {
      return toTicket(updated);
    }
  }

  // Métricas (F8, F9): solo los campos de tiempos y estado. Abiertos hoy, o resueltos en el
  // período o en el anterior de igual largo, o abiertos dentro del período.
  async listForMetrics(tenantKey, { window, category } = {}) {
    const { Ticket } = await this.getModels(tenantKey);
    const filter = {
      $or: [
        { status: { $ne: 'resuelto' } },
        { resolvedAt: { $gte: window.previousFrom, $lt: window.to } },
        { openedAt: { $gte: window.from, $lt: window.to } },
      ],
    };
    if (category) {
      filter.category = String(category);
    }
    const documents = await Ticket.find(filter)
      .select({ status: 1, category: 1, openedAt: 1, firstResponseAt: 1, resolvedAt: 1, reopenCount: 1 })
      .lean();
    return documents.map((document) => ({
      id: idOf(document._id),
      status: document.status,
      category: document.category,
      openedAt: document.openedAt,
      firstResponseAt: document.firstResponseAt ?? null,
      resolvedAt: document.resolvedAt ?? null,
      reopenCount: document.reopenCount ?? 0,
    }));
  }

  async markSeen(tenantKey, id, side, at) {
    const field = SEEN_FIELD[side];
    if (!field || !isObjectId(id)) {
      return;
    }
    const { Ticket } = await this.getModels(tenantKey);
    // $max: una vista vieja que llega tarde no hace retroceder la marca.
    await Ticket.updateOne({ _id: id }, { $max: { [field]: at } }, { timestamps: false });
  }
}

export default MongooseTicketRepository;
