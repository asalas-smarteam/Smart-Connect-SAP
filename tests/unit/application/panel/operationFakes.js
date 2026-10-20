// Lector falso de eventos, syncs y tareas para probar casos de uso y HTTP sin base de datos.
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const clone = (value) => structuredClone(value);

function inRange(date, { from, to } = {}) {
  const ms = new Date(date).getTime();
  return (!from || ms >= from.getTime()) && (!to || ms < to.getTime());
}

export class FakeOperationsReader {
  constructor({ events = {}, syncs = {}, tasks = {} } = {}) {
    this.events = events;
    this.syncs = syncs;
    this.tasks = tasks;
    this.touchedTenants = [];
    this.calls = [];
    this.timeoutNext = false;
  }

  touch(tenantKey, method, args) {
    this.touchedTenants.push(tenantKey);
    this.calls.push({ method, tenantKey, args });
    if (this.timeoutNext) {
      this.timeoutNext = false;
      throw Object.assign(new Error('timeout'), { code: 'PANEL_QUERY_TIMEOUT' });
    }
  }

  async listEvents(tenantKey, { filters = {}, skip = 0, limit = 25 } = {}) {
    this.touch(tenantKey, 'listEvents', { filters, skip, limit });
    const all = (this.events[tenantKey] ?? [])
      .filter((event) => (filters.status ? event.status === filters.status : event.status !== 'report'))
      .filter((event) => filters.type === undefined || event.eventType === filters.type)
      .filter((event) => !filters.references || filters.references.includes(event.payload?.deal?.hs_object_id))
      .filter((event) => inRange(event.createdAt, filters))
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    return {
      items: all.slice(skip, skip + limit).map(({ sapAudit, payload, ...rest }) => ({
        ...clone(rest),
        payload: payload?.deal ? { deal: { hs_object_id: payload.deal.hs_object_id } } : undefined,
      })),
      total: all.length,
    };
  }

  async findEvent(tenantKey, id, { withRaw = false, withExchange = false } = {}) {
    if (!OBJECT_ID.test(String(id))) {
      return null;
    }
    this.touch(tenantKey, 'findEvent', { id, withRaw, withExchange });
    const found = (this.events[tenantKey] ?? []).find((event) => event._id === id);
    if (!found) {
      return null;
    }
    if (withRaw) {
      return clone(found);
    }
    if (withExchange) {
      const { sapAudit, ...rest } = clone(found);
      return sapAudit
        ? { ...rest, sapAudit: { payloadSap: sapAudit.payloadSap, responseSap: sapAudit.responseSap } }
        : rest;
    }
    const { sapAudit, payload, ...rest } = found;
    return { ...clone(rest), payload: payload?.deal ? { deal: { hs_object_id: payload.deal.hs_object_id } } : undefined };
  }

  async listSyncs(tenantKey, { filters = {}, skip = 0, limit = 25 } = {}) {
    this.touch(tenantKey, 'listSyncs', { filters, skip, limit });
    const all = (this.syncs[tenantKey] ?? [])
      .filter((sync) => !filters.hasStatus || (sync.status ?? null) === filters.status)
      .filter((sync) => !filters.taskId || sync.clientConfigId === filters.taskId)
      .filter((sync) => !filters.eventQueue || !sync.clientConfigId)
      .filter((sync) => !filters.hideEmpty || (sync.recordsProcessed ?? 0) > 0)
      .filter((sync) => inRange(sync.startedAt, filters))
      .sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt));
    return { items: all.slice(skip, skip + limit).map(({ errors, ...rest }) => clone(rest)), total: all.length };
  }

  async findSync(tenantKey, id, { errorsSkip = 0, errorsLimit = 0 } = {}) {
    if (!OBJECT_ID.test(String(id))) {
      return null;
    }
    this.touch(tenantKey, 'findSync', { id, errorsSkip, errorsLimit });
    const found = (this.syncs[tenantKey] ?? []).find((sync) => sync._id === id);
    if (!found) {
      return null;
    }
    const { errors = [], ...rest } = clone(found);
    const sync = errorsLimit > 0 ? { ...rest, errors: errors.slice(errorsSkip, errorsSkip + errorsLimit) } : rest;
    return { sync, errorsTotal: errors.length };
  }

  async listEventsForSummary(tenantKey, { from, to, limit }) {
    this.touch(tenantKey, 'listEventsForSummary', { from, to, limit });
    const all = (this.events[tenantKey] ?? [])
      .filter((event) => event.status !== 'report' && inRange(event.createdAt, { from, to }))
      .map(clone);
    return { items: all.slice(0, limit), truncated: all.length > limit };
  }

  async findQueueEventIds(tenantKey, { references, from, to }) {
    this.touch(tenantKey, 'findQueueEventIds', { references, from, to });
    return (this.events[tenantKey] ?? [])
      .filter((event) => event.status === 'errored'
        && references.includes(String(event.payload?.deal?.hs_object_id))
        && new Date(event.updatedAt) >= from && new Date(event.updatedAt) <= to)
      .map((event) => ({ id: event._id, reference: String(event.payload.deal.hs_object_id) }));
  }

  async findTasks(tenantKey, ids) {
    this.touch(tenantKey, 'findTasks', { ids });
    return (this.tasks[tenantKey] ?? [])
      .filter((task) => ids.includes(task._id))
      .map(({ _id, clientName, taskType }) => ({ _id, clientName, taskType }));
  }

  async listTasks(tenantKey) {
    this.touch(tenantKey, 'listTasks', {});
    return (this.tasks[tenantKey] ?? [])
      .map(({ _id, clientName, taskType }) => ({ _id, clientName, taskType }))
      .sort((left, right) => String(left.clientName).localeCompare(String(right.clientName)));
  }
}

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';

export const OPS_IDS = {
  event1: '6711a0b1c2d3e4f500000001',
  event2: '6711a0b1c2d3e4f500000002',
  report: '6711a0b1c2d3e4f500000003',
  foreignEvent: '6711a0b1c2d3e4f500000004',
  sync1: '6711d0e1f2a3b4c500000001',
  sync2: '6711d0e1f2a3b4c500000002',
  task1: '6711c0aa00000000000000a1',
  task2: '6711c0aa00000000000000a2',
};

// Datos de ejemplo: dos eventos y un reporte en ACME, un evento en INITECH, dos syncs en ACME.
export function sampleOperations() {
  const I = OPS_IDS;
  return {
    events: {
      [ACME]: [
        {
          _id: I.event1,
          eventType: 'createQuotation',
          status: 'errored',
          retries: 3,
          maxRetries: 3,
          lastError: 'El artículo no existe.',
          payload: { deal: { hs_object_id: '18374652901', amount: 10 } },
          sapAudit: { request: 'interno' },
          dedupActive: false,
          createdAt: new Date('2026-10-10T14:00:00Z'),
          updatedAt: new Date('2026-10-10T14:06:00Z'),
        },
        {
          _id: I.event2,
          eventType: 'createDeal',
          status: 'sap_order_created',
          retries: 0,
          maxRetries: 3,
          lastError: null,
          payload: { deal: { hs_object_id: 555 } },
          sapAudit: null,
          createdAt: new Date('2026-10-11T09:00:00Z'),
          updatedAt: new Date('2026-10-11T09:00:05Z'),
        },
        { _id: I.report, eventType: 'syncReport', status: 'report', payload: {}, createdAt: new Date('2026-10-12T00:00:00Z') },
      ],
      [INITECH]: [
        { _id: I.foreignEvent, eventType: 'createDeal', status: 'completed', payload: {}, createdAt: new Date('2026-10-11T00:00:00Z') },
      ],
    },
    syncs: {
      [ACME]: [
        {
          _id: I.sync1,
          clientConfigId: I.task1,
          objectType: 'Product',
          status: 'errored',
          recordsProcessed: 120,
          sent: 117,
          failed: 3,
          updated: 40,
          skipped: 2,
          skippedReasons: [{ reason: 'Sin precio', count: 2 }],
          errorMessage: 'Tres productos sin precio.',
          errors: Array.from({ length: 30 }, (_, index) => ({ record: `ITEM-${index}`, message: 'Sin precio' })),
          startedAt: new Date('2026-10-10T06:00:00Z'),
          finishedAt: new Date('2026-10-10T06:04:12Z'),
        },
        {
          _id: I.sync2,
          clientConfigId: '6711c0aa00000000000000ff',
          objectType: 'Contact',
          status: null,
          startedAt: new Date('2026-10-11T06:00:00Z'),
        },
      ],
    },
    tasks: {
      [ACME]: [
        { _id: I.task1, clientName: 'Productos', taskType: 'SAP_SYNC', apiToken: 'nunca' },
        { _id: I.task2, clientName: 'Listas', taskType: 'DROPDOWN_OPTIONS', apiToken: 'nunca' },
      ],
    },
  };
}

// Lector falso de mapeos de campos (plan 6). Devuelve los documentos tal cual, para que el caso de
// uso y la vista prueben que nunca dejan pasar campos internos.
export class FakeFieldMappingReader {
  constructor(mappingsByTenant = {}) {
    this.mappingsByTenant = mappingsByTenant;
    this.touchedTenants = [];
    this.timeoutNext = false;
    this.truncateNext = false;
  }

  async listFieldMappings(tenantKey) {
    this.touchedTenants.push(tenantKey);
    if (this.timeoutNext) {
      this.timeoutNext = false;
      throw Object.assign(new Error('timeout'), { code: 'PANEL_QUERY_TIMEOUT' });
    }
    const truncated = this.truncateNext;
    this.truncateNext = false;
    return { items: clone(this.mappingsByTenant[tenantKey] ?? []), truncated };
  }
}

export const MAPPING_IDS = {
  stock: '6a6b94a1cd7c01b21aa58c41',
  name: '6a6b94a1cd7c01b21aa58c42',
  legacy: '6a6b94a1cd7c01b21aa58c43',
};

export function sampleFieldMappings() {
  return {
    sap_integration_acme: [
      {
        _id: MAPPING_IDS.stock,
        sourceField: 'QuantityOnStock',
        targetField: 'quantity',
        objectType: 'product',
        sourceContext: 'product',
        isActive: true,
        editable: false,
        includeInServiceLayerSelect: false,
        userField: false,
        clientConfigId: '6a6b94a1cd7c01b21aa58c99',
        hubspotCredentialId: '6a6b94a1cd7c01b21aa58c98',
      },
      {
        _id: MAPPING_IDS.name,
        sourceField: 'CardName',
        targetField: 'name',
        objectType: 'company',
        sourceContext: 'businessPartner',
        isActive: false,
        editable: true,
        includeInServiceLayerSelect: true,
        userField: true,
        hubspotCredentialId: '6a6b94a1cd7c01b21aa58c98',
      },
      // Documento viejo: sin booleanos y sourceContext vacío.
      { _id: MAPPING_IDS.legacy, sourceField: 'U_Zona', targetField: 'zona', objectType: 'company', sourceContext: '' },
    ],
  };
}
