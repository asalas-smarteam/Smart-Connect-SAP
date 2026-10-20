// Fakes de los puertos de tickets para probar los casos de uso sin base de datos.
const OBJECT_ID = /^[0-9a-f]{24}$/i;

let sequence = 0;
export function nextObjectId() {
  sequence += 1;
  return sequence.toString(16).padStart(24, '0');
}

const clone = (value) => structuredClone(value);

export class InMemoryTicketRepository {
  constructor() {
    this.byTenant = new Map();
    this.counters = new Map();
    this.touchedTenants = [];
    this.failingTenants = new Set();
    this.slowTenants = new Map();
    this.failNextCreate = false;
    this.failNextUpdate = false;
    this.conflictNextUpdate = false;
  }

  async touch(tenantKey) {
    this.touchedTenants.push(tenantKey);
    if (this.failingTenants.has(tenantKey)) {
      throw new Error(`tenant ${tenantKey} down`);
    }
    const delay = this.slowTenants.get(tenantKey);
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  tickets(tenantKey) {
    if (!this.byTenant.has(tenantKey)) {
      this.byTenant.set(tenantKey, []);
    }
    return this.byTenant.get(tenantKey);
  }

  newId() {
    return nextObjectId();
  }

  async create(tenantKey, ticket, { codeFor }) {
    await this.touch(tenantKey);
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('insert failed');
    }
    const number = (this.counters.get(tenantKey) ?? 0) + 1;
    this.counters.set(tenantKey, number);
    const stored = { ...clone(ticket), number, code: codeFor(number) };
    this.tickets(tenantKey).push(stored);
    return clone(stored);
  }

  async findById(tenantKey, id) {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      return null;
    }
    await this.touch(tenantKey);
    const found = this.tickets(tenantKey).find((ticket) => ticket.id === id);
    return found ? clone(found) : null;
  }

  async list(tenantKey, { status, category, skip = 0, limit = 25 } = {}) {
    await this.touch(tenantKey);
    const all = this.tickets(tenantKey)
      .filter((ticket) => (!status || ticket.status === status) && (!category || ticket.category === category))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
    const items = all.slice(skip, skip + limit).map((ticket) => {
      const { messages, statusHistory, internalResolution, description, attachments, ...rest } = clone(ticket);
      return { ...rest, context: ticket.context ? { type: ticket.context.type } : null };
    });
    return { items, total: all.length };
  }

  async countByStatus(tenantKey) {
    await this.touch(tenantKey);
    const counts = {};
    for (const ticket of this.tickets(tenantKey)) {
      counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
    }
    return counts;
  }

  async update(tenantKey, id, change) {
    await this.touch(tenantKey);
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('update failed');
    }
    const ticket = this.tickets(tenantKey).find((candidate) => candidate.id === id);
    if (!ticket || ticket.status !== change.expectedStatus || this.conflictNextUpdate) {
      this.conflictNextUpdate = false;
      return null;
    }
    Object.assign(ticket, clone(change.set ?? {}));
    for (const [field, amount] of Object.entries(change.inc ?? {})) {
      ticket[field] = (ticket[field] ?? 0) + amount;
    }
    if (change.pushMessage) {
      ticket.messages.push(clone(change.pushMessage));
    }
    for (const entry of change.pushHistory ?? []) {
      ticket.statusHistory.push(clone(entry));
    }
    for (const [field, value] of Object.entries(change.setIfNull ?? {})) {
      if (ticket[field] === null || ticket[field] === undefined) {
        ticket[field] = value;
      }
    }
    return clone(ticket);
  }

  async listForMetrics(tenantKey, { window, category } = {}) {
    await this.touch(tenantKey);
    const inRange = (value, from, to) => value && new Date(value) >= from && new Date(value) < to;
    return this.tickets(tenantKey)
      .filter((ticket) => !category || ticket.category === category)
      .filter((ticket) => ticket.status !== 'resuelto'
        || inRange(ticket.resolvedAt, window.previousFrom, window.to)
        || inRange(ticket.openedAt, window.from, window.to))
      .map(({ id, status, category: ticketCategory, openedAt, firstResponseAt, resolvedAt, reopenCount }) => clone({
        id, status, category: ticketCategory, openedAt, firstResponseAt: firstResponseAt ?? null, resolvedAt: resolvedAt ?? null, reopenCount: reopenCount ?? 0,
      }));
  }

  async markSeen(tenantKey, id, side, at) {
    await this.touch(tenantKey);
    const ticket = this.tickets(tenantKey).find((candidate) => candidate.id === id);
    const field = side === 'cliente' ? 'clientLastSeenAt' : 'staffLastSeenAt';
    if (ticket && (!ticket[field] || ticket[field] < at)) {
      ticket[field] = at;
    }
  }
}

export class FakeAttachmentStore {
  constructor() {
    this.files = new Map();
    this.removed = [];
    this.failOnPutNumber = null;
    this.puts = 0;
  }

  async put(tenantKey, { ticketId, filename, contentType, data }) {
    this.puts += 1;
    if (this.failOnPutNumber === this.puts) {
      throw new Error('gridfs down');
    }
    const fileId = nextObjectId();
    this.files.set(fileId, { tenantKey, ticketId, filename, contentType, data });
    return { fileId, filename, contentType, size: data.length };
  }

  async open(tenantKey, { ticketId, fileId }) {
    const file = this.files.get(fileId);
    if (!file || file.tenantKey !== tenantKey || file.ticketId !== ticketId) {
      return null;
    }
    return { stream: file.data, contentType: file.contentType, size: file.data.length };
  }

  async remove(tenantKey, fileIds) {
    for (const fileId of fileIds) {
      this.removed.push(fileId);
      this.files.delete(fileId);
    }
  }
}

export class FakeContextReader {
  constructor({ events = {}, syncs = {} } = {}) {
    this.events = events;
    this.syncs = syncs;
  }

  async readEvent(tenantKey, id) {
    return this.events[tenantKey]?.[id] ?? null;
  }

  async readSync(tenantKey, id) {
    return this.syncs[tenantKey]?.[id] ?? null;
  }
}

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

export function image(data = PNG, filename = 'captura.png') {
  return { filename, data };
}

// Reloj controlable: cada llamada avanza un minuto.
export function steppingClock(start = '2026-10-12T10:00:00.000Z') {
  let current = new Date(start).getTime();
  return () => {
    const value = new Date(current);
    current += 60 * 1000;
    return value;
  };
}
