// Dobles en memoria para la edición del mapeo de responsables (plan 12, contrato 14).
import { OWNER_IDS, sampleOwnerMappings } from './operationFakes.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
export const ACME_CREDENTIAL = '6a6b94a1cd7c01b21aa58c98';
export const ACME_CREDENTIAL_2 = '6a6b94a1cd7c01b21aa58c99';

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `6b00000000000000000${String(idCounter).padStart(5, '0')}`;
}

function copy(row) {
  return row ? structuredClone(row) : row;
}

// Escritor en memoria: updatedAt avanza un segundo por escritura (como los timestamps de
// Mongoose), el índice único del vendedor por credencial se simula y el historial queda en
// this.history por tenant.
export class InMemoryOwnerMappingWriter {
  constructor(rowsByTenant = sampleOwnerMappings(), { clockStart = Date.parse('2026-11-20T15:00:00.000Z') } = {}) {
    this.rows = new Map(Object.entries(rowsByTenant).map(([tenant, rows]) => [tenant, rows.map(copy)]));
    this.history = new Map();
    this.clock = clockStart;
    this.updateCalls = 0;
    this.refreshCalls = [];
    this.failHistoryNext = false;
    this.raceOnInsert = new Set();
    this.touchedTenants = [];
  }

  tick() {
    this.clock += 1000;
    return new Date(this.clock);
  }

  tenantRows(tenantKey) {
    if (!this.rows.has(tenantKey)) {
      this.rows.set(tenantKey, []);
    }
    return this.rows.get(tenantKey);
  }

  historyOf(tenantKey) {
    return this.history.get(tenantKey) ?? [];
  }

  find(tenantKey, id) {
    return this.tenantRows(tenantKey).find((row) => String(row._id) === String(id)) ?? null;
  }

  async findById(tenantKey, id) {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      return null;
    }
    this.touchedTenants.push(tenantKey);
    return copy(this.find(tenantKey, id));
  }

  async updateErpCodes(tenantKey, id, { expectedUpdatedAt, set }) {
    this.updateCalls += 1;
    const row = this.find(tenantKey, id);
    if (!row || !row.updatedAt || new Date(row.updatedAt).getTime() !== expectedUpdatedAt.getTime()) {
      return null;
    }
    if (typeof set.sapOwnerId === 'string') {
      const taken = this.tenantRows(tenantKey).some((other) => other !== row
        && String(other.hubspotCredentialId) === String(row.hubspotCredentialId)
        && other.sapOwnerId === set.sapOwnerId);
      if (taken) {
        throw Object.assign(new Error('E11000'), { code: 'ERP_OWNER_TAKEN' });
      }
    }
    Object.assign(row, set, { updatedAt: this.tick() });
    return copy(row);
  }

  async listByCredential(tenantKey, credentialId) {
    return this.tenantRows(tenantKey)
      .filter((row) => String(row.hubspotCredentialId) === String(credentialId))
      .map(({ _id, hubspotOwnerId, hubspotOwnerName, hubspotOwnerEmail }) => copy({ _id, hubspotOwnerId, hubspotOwnerName, hubspotOwnerEmail }));
  }

  async insertSeeded(tenantKey, { hubspotCredentialId, hubspotOwnerId, hubspotOwnerName, hubspotOwnerEmail }) {
    const rows = this.tenantRows(tenantKey);
    const exists = rows.some((row) => String(row.hubspotCredentialId) === String(hubspotCredentialId)
      && String(row.hubspotOwnerId) === String(hubspotOwnerId));
    if (this.raceOnInsert.has(String(hubspotOwnerId))) {
      // Otra sincronización la insertó entre la lectura y la inserción (E11000).
      this.raceOnInsert.delete(String(hubspotOwnerId));
      rows.push({ _id: nextId(), hubspotCredentialId, hubspotOwnerId, hubspotOwnerName, hubspotOwnerEmail, sapOwnerId: null, sapOwnerId_2: null, sapOwnerName: null, active: true, source: 'hubspot_seed' });
      return null;
    }
    if (exists) {
      return null;
    }
    const at = this.tick();
    const row = {
      _id: nextId(),
      hubspotCredentialId,
      hubspotOwnerId,
      hubspotOwnerName,
      hubspotOwnerEmail,
      sapOwnerId: null,
      sapOwnerId_2: null,
      sapOwnerName: null,
      active: true,
      source: 'hubspot_seed',
      createdAt: at,
      updatedAt: at,
    };
    rows.push(row);
    return copy(row);
  }

  async refreshCrmOwnerData(tenantKey, id, { hubspotOwnerName, hubspotOwnerEmail }) {
    this.refreshCalls.push(String(id));
    const row = this.find(tenantKey, id);
    if (row) {
      Object.assign(row, { hubspotOwnerName, hubspotOwnerEmail });
    }
  }

  async countAll(tenantKey) {
    return this.tenantRows(tenantKey).length;
  }

  async appendHistory(tenantKey, entry) {
    if (this.failHistoryNext) {
      this.failHistoryNext = false;
      throw new Error('history down');
    }
    if (!this.history.has(tenantKey)) {
      this.history.set(tenantKey, []);
    }
    this.history.get(tenantKey).push(copy(entry));
  }
}

// Directorio del CRM falso: credenciales por tenant, responsables por credencial, credenciales
// que fallan y conteo de llamadas.
export class FakeCrmOwnerDirectory {
  constructor({ credentialsByTenant = {}, ownersByCredential = {} } = {}) {
    this.credentialsByTenant = credentialsByTenant;
    this.ownersByCredential = ownersByCredential;
    this.failing = new Set();
    this.listCalls = 0;
    this.fetchCalls = [];
  }

  async listCredentials(tenantKey) {
    this.listCalls += 1;
    return (this.credentialsByTenant[tenantKey] ?? []).map((id) => ({ id }));
  }

  async fetchOwners(tenantKey, credentialId) {
    this.fetchCalls.push(credentialId);
    if (this.failing.has(credentialId)) {
      throw Object.assign(new Error('Request failed with status code 401'), { details: { status: 401 } });
    }
    return structuredClone(this.ownersByCredential[credentialId] ?? []);
  }
}

// Acme con una credencial: Erick sigue igual, Ana cambió de correo y hay dos nuevos.
export function sampleCrmDirectory() {
  return new FakeCrmOwnerDirectory({
    credentialsByTenant: { sap_integration_acme: [ACME_CREDENTIAL] },
    ownersByCredential: {
      [ACME_CREDENTIAL]: [
        { hubspotOwnerId: '82929225', hubspotOwnerName: 'Erick Figueroa', hubspotOwnerEmail: 'ventas8@acme.test' },
        { hubspotOwnerId: '91000001', hubspotOwnerName: 'Ana Mora', hubspotOwnerEmail: 'ana@acme.test' },
        { hubspotOwnerId: '93000001', hubspotOwnerName: 'Luis Vega', hubspotOwnerEmail: 'luis@acme.test' },
        { hubspotOwnerId: '93000002', hubspotOwnerName: null, hubspotOwnerEmail: 'sin.nombre@acme.test' },
      ],
    },
  });
}

export { OWNER_IDS };
