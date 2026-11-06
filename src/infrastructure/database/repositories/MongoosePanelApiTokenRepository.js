import PanelApiToken from '../models/global/PanelApiToken.js';
import { apiTokenPurgeAt } from '#domain/panel/apiTokens.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
// lastUsedAt se escribe como mucho una vez por minuto por token (M7).
const TOUCH_INTERVAL_MS = 60 * 1000;
// tokenHash nunca sale de la base hacia los casos de uso.
const WITHOUT_HASH = Object.freeze({ tokenHash: 0 });

function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

function idOf(value) {
  return value === undefined || value === null ? null : String(value);
}

function toMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// Documento lean → registro plano con ids en texto. Nunca incluye tokenHash ni purgeAt.
function toApiToken(document) {
  if (!document) {
    return null;
  }

  return {
    id: idOf(document._id),
    userId: idOf(document.userId),
    name: document.name,
    prefix: document.prefix,
    createdAt: document.createdAt,
    expiresAt: document.expiresAt,
    lastUsedAt: document.lastUsedAt ?? null,
    revokedAt: document.revokedAt ?? null,
    revokedReason: document.revokedReason ?? null,
  };
}

function activeFilter(userId, now) {
  return { userId, revokedAt: null, expiresAt: { $gt: now } };
}

// Tokens personales del panel en la base master (PanelApiTokens, contrato 12 M2).
export class MongoosePanelApiTokenRepository {
  constructor({ model = PanelApiToken } = {}) {
    this.model = model;
  }

  // purgeAt = expiresAt + 30 d: el índice TTL borra el documento un mes después de vencer.
  async create({ userId, name, tokenHash, prefix, createdAt, expiresAt }) {
    const document = await this.model.create({
      userId,
      name,
      tokenHash,
      prefix,
      createdAt,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      revokedReason: null,
      purgeAt: apiTokenPurgeAt(expiresAt),
    });
    return toApiToken(document.toObject ? document.toObject() : document);
  }

  async listActiveByUser(userId, now) {
    if (!isObjectId(userId)) {
      return [];
    }
    const documents = await this.model
      .find(activeFilter(userId, now))
      .select(WITHOUT_HASH)
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    return documents.map(toApiToken);
  }

  async countActiveByUser(userId, now) {
    if (!isObjectId(userId)) {
      return 0;
    }
    return this.model.countDocuments(activeFilter(userId, now));
  }

  // Devuelve el registro aunque esté revocado o vencido: el caso de uso decide si sirve.
  async findByHash(tokenHash) {
    if (typeof tokenHash !== 'string' || tokenHash.length === 0) {
      return null;
    }
    const document = await this.model.findOne({ tokenHash }).select(WITHOUT_HASH).lean();
    return toApiToken(document);
  }

  // Solo revoca si el token es del usuario y no estaba revocado. purgeAt pasa a revokedAt + 30 d.
  async revoke({ userId, id, reason, at }) {
    if (!isObjectId(userId) || !isObjectId(id)) {
      return null;
    }
    const document = await this.model.findOneAndUpdate(
      { _id: id, userId, revokedAt: null },
      { $set: { revokedAt: at, revokedReason: reason, purgeAt: apiTokenPurgeAt(at) } },
      { new: true, lean: true, runValidators: true, projection: WITHOUT_HASH }
    );
    return toApiToken(document);
  }

  // Revoca todos los no revocados del usuario, también los vencidos (así su purgeAt se adelanta
  // igual). Cada uno va con su propia escritura condicional: si otro request revocó alguno en el
  // medio, no se cuenta como revocado por esta llamada.
  async revokeAllForUser({ userId, reason, at }) {
    if (!isObjectId(userId)) {
      return [];
    }
    const pending = await this.model.find({ userId, revokedAt: null }).select({ _id: 1 }).lean();
    const revoked = [];
    for (const { _id } of pending) {
      const record = await this.revoke({ userId, id: idOf(_id), reason, at });
      if (record) {
        revoked.push(record);
      }
    }
    return revoked;
  }

  // Escritura condicional: solo si lastUsedAt está vacío o tiene más de 60 s. true si escribió.
  async touchLastUsed(id, at) {
    if (!isObjectId(id)) {
      return false;
    }
    const result = await this.model.updateOne(
      {
        _id: id,
        $or: [
          { lastUsedAt: null },
          { lastUsedAt: { $lt: new Date(toMs(at) - TOUCH_INTERVAL_MS) } },
        ],
      },
      { $set: { lastUsedAt: at } }
    );
    return Number(result?.modifiedCount ?? 0) > 0;
  }
}

export default MongoosePanelApiTokenRepository;
