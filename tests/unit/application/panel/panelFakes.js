// Dobles en memoria para los casos de uso del panel. No es un archivo de test.
import { PanelEmailTakenError } from '../../../../src/domain/panel/errors.js';

let idCounter = 0;

export function nextId() {
  idCounter += 1;
  return idCounter.toString(16).padStart(24, '0');
}

export class InMemoryPanelUserRepository {
  constructor(users = []) {
    this.users = users.map((user) => ({ ...user }));
    this.lastLogins = [];
  }

  #find(id) {
    return this.users.find((user) => user.id === String(id)) ?? null;
  }

  async findByEmail(email) {
    const user = this.users.find((candidate) => candidate.email === email);
    return user ? { ...user } : null;
  }

  async findById(id) {
    const user = this.#find(id);
    return user ? { ...user } : null;
  }

  async create(data) {
    if (this.users.some((user) => user.email === data.email)) {
      throw new PanelEmailTakenError();
    }

    const user = {
      id: nextId(),
      tokenVersion: 0,
      lastLoginAt: null,
      createdAt: new Date(Date.UTC(2026, 9, 1) + this.users.length * 1000),
      ...data,
    };
    this.users.push(user);
    return { ...user };
  }

  async update(id, patch) {
    const user = this.#find(id);
    if (!user) {
      return null;
    }
    Object.assign(user, patch);
    return { ...user };
  }

  async incrementTokenVersion(id, extraPatch = {}, { expectedVersion } = {}) {
    const user = this.#find(id);
    if (!user || (expectedVersion !== undefined && user.tokenVersion !== expectedVersion)) {
      return null;
    }
    Object.assign(user, extraPatch);
    user.tokenVersion += 1;
    return { ...user };
  }

  async list({ tenantKey, page, pageSize }) {
    const filtered = this.users
      .filter((user) => !tenantKey || user.tenantKey === tenantKey)
      .sort((left, right) => right.createdAt - left.createdAt);

    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize).map((user) => ({ ...user })),
      total: filtered.length,
    };
  }

  async touchLastLogin(id, date) {
    const user = this.#find(id);
    if (user) {
      user.lastLoginAt = date;
    }
    this.lastLogins.push({ id, date });
  }
}

export class FakeTenantDirectory {
  constructor(tenants = []) {
    this.tenants = tenants;
    this.findManyCalls = 0;
  }

  async findByKey(tenantKey) {
    return this.tenants.find((tenant) => tenant.tenantKey === tenantKey) ?? null;
  }

  async findManyByKeys(tenantKeys) {
    this.findManyCalls += 1;
    return this.tenants.filter((tenant) => tenantKeys.includes(tenant.tenantKey));
  }

  async listAll() {
    return [...this.tenants];
  }
}

export class FakePasswordHasher {
  constructor() {
    this.dummyCalls = 0;
  }

  async hash(password) {
    return `hash:${password}`;
  }

  async verify(password, storedHash) {
    return typeof password === 'string' && storedHash === `hash:${password}`;
  }

  async verifyDummy() {
    this.dummyCalls += 1;
    return false;
  }
}

let sidCounter = 0;

export class FakeSessionToken {
  sign(payload) {
    sidCounter += 1;
    return `token:${JSON.stringify({
      sub: payload.sub,
      sid: `sid-${sidCounter}`,
      tv: payload.tv,
      pwdChange: Boolean(payload.pwdChange),
      exp: Math.floor(Date.UTC(2026, 9, 13, 20) / 1000),
    })}`;
  }

  verify(token) {
    if (typeof token !== 'string' || !token.startsWith('token:')) {
      return null;
    }
    try {
      return JSON.parse(token.slice('token:'.length));
    } catch (error) {
      return null;
    }
  }
}

export class FakeLoginAttempts {
  constructor(maxAttempts = 5) {
    this.maxAttempts = maxAttempts;
    this.failures = new Map();
  }

  async consume(email) {
    const count = (this.failures.get(email) ?? 0) + 1;
    this.failures.set(email, count);
    return { blocked: count > this.maxAttempts, firstBlocked: count === this.maxAttempts + 1 };
  }

  async reset(email) {
    this.failures.delete(email);
  }
}

export class SequenceTemporaryPassword {
  constructor() {
    this.count = 0;
  }

  generate() {
    this.count += 1;
    return `Temporal${String(this.count).padStart(6, '0')}`;
  }
}

export const TENANTS = [
  { tenantKey: 'sap_integration_acme', companyName: 'Acme Industrial', status: 'active' },
  { tenantKey: 'sap_integration_initech', companyName: 'Initech Servicios', status: 'suspended' },
];

export function staffUser(overrides = {}) {
  return {
    id: nextId(),
    email: 'dev@smarteam.test',
    name: 'Dev Smarteam',
    accountType: 'smarteam',
    tenantKey: null,
    role: null,
    passwordHash: 'hash:clave-del-staff',
    mustChangePassword: false,
    active: true,
    tokenVersion: 0,
    lastLoginAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function clientUser(overrides = {}) {
  return {
    id: nextId(),
    email: 'admin@acme.test',
    name: 'Adriana Solís',
    accountType: 'cliente',
    tenantKey: 'sap_integration_acme',
    role: 'admin',
    passwordHash: 'hash:clave-del-cliente',
    mustChangePassword: false,
    active: true,
    tokenVersion: 0,
    lastLoginAt: null,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  };
}

export class RecordingAuditLog {
  constructor() {
    this.entries = [];
  }

  async record(entry) {
    this.entries.push(entry);
  }

  actions() {
    return this.entries.map((entry) => entry.action);
  }
}

export class FakeRevokedSessions {
  constructor() {
    this.revoked = new Map();
  }

  async revoke({ sid, userId, expiresAt }) {
    if (this.revoked.has(sid)) {
      return false;
    }
    this.revoked.set(sid, { userId, expiresAt });
    return true;
  }

  async isRevoked(sid) {
    return this.revoked.has(sid);
  }
}
