import PanelIdempotencyKey from '../models/global/PanelIdempotencyKey.js';

const DUPLICATE_KEY_ERROR = 11000;
// La clave se recuerda 24 h desde la primera reserva (M5).
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

function toMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

// Documento lean → registro plano. Sin cuerpos ni textos del ticket: no se guardan.
function toRecord(document) {
  if (!document) {
    return null;
  }

  return {
    ownerKey: document.ownerKey,
    key: document.key,
    fingerprint: document.fingerprint,
    state: document.state,
    tenantKey: document.tenantKey ?? null,
    ticketId: document.ticketId ?? null,
    entryId: document.entryId ?? null,
    status: document.status ?? null,
    createdAt: document.createdAt,
    expiresAt: document.expiresAt,
  };
}

// Registro de claves Idempotency-Key en la base master (PanelIdempotencyKeys, contrato 12 M5).
export class MongooseIdempotencyStore {
  constructor({ model = PanelIdempotencyKey, now = () => new Date() } = {}) {
    this.model = model;
    this.now = now;
  }

  // Solo claves vigentes: el índice TTL borra con hasta ~60 s de atraso, y una clave vencida no
  // debe responder. now: hora del request (por defecto, el reloj del adaptador).
  async find({ ownerKey, key, now = this.now() }) {
    if (!isText(ownerKey) || !isText(key)) {
      return null;
    }
    return toRecord(await this.model.findOne({ ownerKey, key, expiresAt: { $gt: now } }).lean());
  }

  // Inserta la reserva. Si choca con el índice único (otro request con la misma clave se
  // adelantó) devuelve null y el caso de uso vuelve a leer.
  async reserve({ ownerKey, key, fingerprint, at }) {
    if (!isText(ownerKey) || !isText(key) || !isText(fingerprint)) {
      throw new TypeError('ownerKey, key y fingerprint son obligatorios');
    }
    try {
      const document = await this.model.create({
        ownerKey,
        key,
        fingerprint,
        state: 'pending',
        tenantKey: null,
        ticketId: null,
        entryId: null,
        status: null,
        createdAt: at,
        expiresAt: new Date(toMs(at) + KEY_TTL_MS),
      });
      return toRecord(document.toObject ? document.toObject() : document);
    } catch (error) {
      if (error?.code === DUPLICATE_KEY_ERROR) {
        return null;
      }
      throw error;
    }
  }

  // Retoma un pending abandonado (createdAt < staleBefore) con la misma huella. expiresAt no
  // cambia: la clave sigue venciendo 24 h después de la primera reserva.
  async takeOver({ ownerKey, key, fingerprint, staleBefore, at }) {
    if (!isText(ownerKey) || !isText(key) || !isText(fingerprint)) {
      return null;
    }
    const document = await this.model.findOneAndUpdate(
      { ownerKey, key, state: 'pending', fingerprint, createdAt: { $lt: staleBefore } },
      { $set: { createdAt: at } },
      { new: true, lean: true }
    );
    return toRecord(document);
  }

  // Marca done solo la reserva propia (mismo createdAt): si otro request la retomó, no escribe.
  async complete({ ownerKey, key, createdAt, tenantKey, ticketId, entryId, status }) {
    if (!isText(ownerKey) || !isText(key)) {
      return false;
    }
    const result = await this.model.updateOne(
      { ownerKey, key, state: 'pending', createdAt },
      { $set: { state: 'done', tenantKey, ticketId, entryId, status } }
    );
    return Number(result?.modifiedCount ?? 0) > 0;
  }

  // Borra la reserva propia si sigue pending (el request terminó en 4xx o 5xx). true si borró.
  async release({ ownerKey, key, createdAt }) {
    if (!isText(ownerKey) || !isText(key)) {
      return false;
    }
    const result = await this.model.deleteOne({ ownerKey, key, state: 'pending', createdAt });
    return Number(result?.deletedCount ?? 0) > 0;
  }
}

export default MongooseIdempotencyStore;
