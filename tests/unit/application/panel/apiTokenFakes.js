// Dobles en memoria de los puertos de tokens personales e idempotencia (contrato 12, M2 y M5).
// No es un archivo de test. Misma semántica que MongoosePanelApiTokenRepository y
// MongooseIdempotencyStore.
import crypto from 'crypto';
import { apiTokenPurgeAt } from '../../../../src/domain/panel/apiTokens.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const TOUCH_INTERVAL_MS = 60 * 1000;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

let tokenSequence = 0;
function nextTokenId() {
  tokenSequence += 1;
  // Con 'a' al frente para no chocar con los ids de panelFakes y ticketFakes.
  return `a${tokenSequence.toString(16).padStart(23, '0')}`;
}

const ms = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());
const isObjectId = (value) => typeof value === 'string' && OBJECT_ID.test(value);
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

// Registro público: sin tokenHash ni purgeAt.
function toApiToken(record) {
  if (!record) {
    return null;
  }
  const { tokenHash, purgeAt, ...rest } = record;
  return structuredClone(rest);
}

function isActive(record, now) {
  return record.revokedAt === null && ms(record.expiresAt) > ms(now);
}

export class InMemoryApiTokenRepository {
  constructor() {
    // Registros internos, con tokenHash y purgeAt, para que las pruebas los inspeccionen.
    this.records = [];
    this.failNextCreate = false;
    this.failNextRevokeAll = false;
    this.failNextTouch = false;
    this.touches = [];
  }

  async create({ userId, name, tokenHash, prefix, createdAt, expiresAt }) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('api token insert failed');
    }
    if (this.records.some((record) => record.tokenHash === tokenHash)) {
      throw Object.assign(new Error('E11000 duplicate key tokenHash'), { code: 11000 });
    }
    const record = {
      id: nextTokenId(),
      userId: String(userId),
      name,
      tokenHash,
      prefix,
      createdAt,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      revokedReason: null,
      purgeAt: apiTokenPurgeAt(expiresAt),
    };
    this.records.push(record);
    return toApiToken(record);
  }

  async listActiveByUser(userId, now) {
    return this.records
      .filter((record) => record.userId === userId && isActive(record, now))
      .sort((left, right) => ms(right.createdAt) - ms(left.createdAt) || right.id.localeCompare(left.id))
      .map(toApiToken);
  }

  async countActiveByUser(userId, now) {
    return this.records.filter((record) => record.userId === userId && isActive(record, now)).length;
  }

  async findByHash(tokenHash) {
    if (typeof tokenHash !== 'string' || tokenHash.length === 0) {
      return null;
    }
    return toApiToken(this.records.find((record) => record.tokenHash === tokenHash) ?? null);
  }

  async revoke({ userId, id, reason, at }) {
    if (!isObjectId(userId) || !isObjectId(id)) {
      return null;
    }
    const record = this.records.find((candidate) => candidate.id === id
      && candidate.userId === userId
      && candidate.revokedAt === null);
    if (!record) {
      return null;
    }
    record.revokedAt = at;
    record.revokedReason = reason;
    record.purgeAt = apiTokenPurgeAt(at);
    return toApiToken(record);
  }

  async revokeAllForUser({ userId, reason, at }) {
    if (this.failNextRevokeAll) {
      this.failNextRevokeAll = false;
      throw new Error('api token revoke failed');
    }
    const pending = this.records.filter((record) => record.userId === userId && record.revokedAt === null);
    const revoked = [];
    for (const record of pending) {
      const result = await this.revoke({ userId, id: record.id, reason, at });
      if (result) {
        revoked.push(result);
      }
    }
    return revoked;
  }

  async touchLastUsed(id, at) {
    if (this.failNextTouch) {
      this.failNextTouch = false;
      throw new Error('api token touch failed');
    }
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record || (record.lastUsedAt !== null && ms(record.lastUsedAt) >= ms(at) - TOUCH_INTERVAL_MS)) {
      return false;
    }
    record.lastUsedAt = at;
    this.touches.push({ id, at });
    return true;
  }
}

// Tokens válidos (^spn_[A-Za-z0-9_-]{43}$), deterministas y únicos; hash SHA-256 real.
// El prefijo cambia con cada token: 'spn_0001', 'spn_0002'…
export class FakeApiTokenCodec {
  constructor() {
    this.count = 0;
    this.generated = [];
  }

  generate() {
    this.count += 1;
    const token = `spn_${String(this.count).padStart(4, '0')}${'T'.repeat(39)}`;
    const generated = { token, hash: sha256(token), prefix: token.slice(0, 8) };
    this.generated.push(generated);
    return { ...generated };
  }

  hash(value) {
    return sha256(value);
  }
}

export class InMemoryIdempotencyStore {
  constructor() {
    this.entries = new Map();
    this.failNextComplete = false;
    this.failNextRelease = false;
    this.calls = [];
  }

  // Registros guardados (copias), para que las pruebas los inspeccionen.
  get records() {
    return [...this.entries.values()].map((record) => structuredClone(record));
  }

  static id(ownerKey, key) {
    return `${ownerKey}\u0000${key}`;
  }

  // Como el adaptador: con now, una clave vencida (expiresAt <= now) no se devuelve.
  async find({ ownerKey, key, now = null }) {
    this.calls.push('find');
    const record = this.entries.get(InMemoryIdempotencyStore.id(ownerKey, key));
    if (!record || (now && !(ms(record.expiresAt) > ms(now)))) {
      return null;
    }
    return structuredClone(record);
  }

  async reserve({ ownerKey, key, fingerprint, at }) {
    this.calls.push('reserve');
    const id = InMemoryIdempotencyStore.id(ownerKey, key);
    if (this.entries.has(id)) {
      return null;
    }
    const record = {
      ownerKey,
      key,
      fingerprint,
      state: 'pending',
      tenantKey: null,
      ticketId: null,
      entryId: null,
      status: null,
      createdAt: at,
      expiresAt: new Date(ms(at) + KEY_TTL_MS),
    };
    this.entries.set(id, record);
    return structuredClone(record);
  }

  async takeOver({ ownerKey, key, fingerprint, staleBefore, at }) {
    this.calls.push('takeOver');
    const record = this.entries.get(InMemoryIdempotencyStore.id(ownerKey, key));
    if (!record || record.state !== 'pending' || record.fingerprint !== fingerprint
      || !(ms(record.createdAt) < ms(staleBefore))) {
      return null;
    }
    record.createdAt = at;
    return structuredClone(record);
  }

  async complete({ ownerKey, key, createdAt, tenantKey, ticketId, entryId, status }) {
    this.calls.push('complete');
    if (this.failNextComplete) {
      this.failNextComplete = false;
      throw new Error('idempotency complete failed');
    }
    const record = this.entries.get(InMemoryIdempotencyStore.id(ownerKey, key));
    if (!record || record.state !== 'pending' || ms(record.createdAt) !== ms(createdAt)) {
      return false;
    }
    Object.assign(record, { state: 'done', tenantKey, ticketId, entryId, status });
    return true;
  }

  async release({ ownerKey, key, createdAt }) {
    this.calls.push('release');
    if (this.failNextRelease) {
      this.failNextRelease = false;
      throw new Error('idempotency release failed');
    }
    const id = InMemoryIdempotencyStore.id(ownerKey, key);
    const record = this.entries.get(id);
    if (!record || record.state !== 'pending' || ms(record.createdAt) !== ms(createdAt)) {
      return false;
    }
    this.entries.delete(id);
    return true;
  }
}
