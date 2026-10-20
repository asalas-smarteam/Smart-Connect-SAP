import mongoose from 'mongoose';
import { PanelQueryTimeoutError } from '#domain/panel/errors.js';
import { getTenantConnection } from '../tenant/tenantDatabase.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const MAX_TIME_EXPIRED = 50;
export const DEFAULT_MAX_TIME_MS = 5000;

// Solo lo que muestra el panel. Nunca la auditoría interna salvo withRaw, nunca los errores de
// una corrida en las listas, y de la configuración de tareas solo el nombre y el tipo (ahí
// viven las credenciales).
const EVENT_FIELDS = Object.freeze({
  eventType: 1,
  status: 1,
  retries: 1,
  maxRetries: 1,
  lastError: 1,
  createdAt: 1,
  updatedAt: 1,
});
const EVENT_LIST_PROJECTION = Object.freeze({ ...EVENT_FIELDS, 'payload.deal.hs_object_id': 1 });
const EVENT_RAW_PROJECTION = Object.freeze({ ...EVENT_FIELDS, payload: 1, sapAudit: 1 });
// Detalle con intercambio (plan 5c): el payload y solo lo enviado y respondido por el ERP;
// nunca sapCalls ni el resto de la auditoría.
const EVENT_EXCHANGE_PROJECTION = Object.freeze({
  ...EVENT_FIELDS,
  payload: 1,
  'sapAudit.payloadSap': 1,
  'sapAudit.responseSap': 1,
});

function eventProjection({ withRaw, withExchange }) {
  if (withRaw) {
    return EVENT_RAW_PROJECTION;
  }
  return withExchange ? EVENT_EXCHANGE_PROJECTION : EVENT_LIST_PROJECTION;
}

const SYNC_FIELDS = Object.freeze({
  clientConfigId: 1,
  objectType: 1,
  status: 1,
  recordsProcessed: 1,
  sent: 1,
  failed: 1,
  updated: 1,
  skipped: 1,
  skippedReasons: 1,
  errorMessage: 1,
  startedAt: 1,
  finishedAt: 1,
});

const TASK_PROJECTION = Object.freeze({ clientName: 1, taskType: 1 });

// Mapeo de campos (plan 6): solo lo que muestra el panel. clientConfigId y hubspotCredentialId
// no salen de la base.
export const FIELD_MAPPING_PROJECTION = Object.freeze({
  sourceField: 1,
  targetField: 1,
  objectType: 1,
  sourceContext: 1,
  isActive: 1,
  editable: 1,
  includeInServiceLayerSelect: 1,
  userField: 1,
});
const FIELD_MAPPING_SORT = Object.freeze({ objectType: 1, sourceContext: 1, sourceField: 1, _id: 1 });
// Tope de seguridad: un tenant real tiene cientos de mapeos.
export const MAX_FIELD_MAPPINGS = 5000;

// Tareas programadas (plan 7): lista blanca con solo los campos de la vista. Nada de credenciales,
// consultas, procedimientos ni ids internos sale de la base (contrato 09, J3).
export const SCHEDULED_TASK_PROJECTION = Object.freeze({
  clientName: 1,
  taskType: 1,
  objectType: 1,
  serviceLayerPath: 1,
  mode: 1,
  intervalMinutes: 1,
  executionTime: 1,
  executionDays: 1,
  startTime: 1,
  endTime: 1,
  hubspotBatchSize: 1,
  associationFetchEnabled: 1,
  requireUpdateHubspotID: 1,
  filters: 1,
  orderBy: 1,
  active: 1,
  lastRun: 1,
  lastError: 1,
});
const SCHEDULED_TASK_SORT = Object.freeze({ active: -1, clientName: 1, _id: 1 });
export const MAX_SCHEDULED_TASKS = 1000;

function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(value);
}

function dateRange(field, { from, to }) {
  if (!from && !to) {
    return {};
  }
  const range = {};
  if (from) {
    range.$gte = from;
  }
  if (to) {
    range.$lt = to;
  }
  return { [field]: range };
}

export function eventFilter(filters = {}) {
  const filter = {
    status: filters.status ?? { $ne: 'report' },
    ...dateRange('createdAt', filters),
  };
  if (filters.type !== undefined) {
    filter.eventType = String(filters.type);
  }
  if (filters.references?.length) {
    filter['payload.deal.hs_object_id'] = { $in: filters.references };
  }
  return filter;
}

export function syncFilter(filters = {}) {
  const filter = { ...dateRange('startedAt', filters) };
  if (filters.hasStatus) {
    filter.status = filters.status ?? null;
  }
  if (filters.taskId) {
    filter.clientConfigId = toObjectId(filters.taskId);
  } else if (filters.eventQueue) {
    // null también calza con el campo ausente: así se guardan las corridas de la cola.
    filter.clientConfigId = null;
  }
  if (filters.hideEmpty) {
    filter.recordsProcessed = { $gt: 0 };
  }
  return filter;
}

// Eventos del resumen (F2): solo lo que el cálculo necesita. Del payload, la referencia y el
// nombre del negocio; de la auditoría, el número de documento. Nunca el resto.
const SUMMARY_PROJECTION = Object.freeze({
  status: 1,
  // Cortado en la base: 20 000 eventos con textos de error enormes no deben llenar la memoria.
  lastError: { $cond: [{ $eq: [{ $type: '$lastError' }, 'string'] }, { $substrCP: ['$lastError', 0, 2000] }, null] },
  createdAt: 1,
  updatedAt: 1,
  'payload.deal.hs_object_id': 1,
  'payload.deal.dealname': 1,
  'sapAudit.responseSap.DocNum': 1,
});

// Lectura de eventos, syncs y tareas con el driver nativo sobre la conexión del tenant: no
// registra modelos, así que leer no crea colecciones, bases ni índices. Solo lectura.
export class TenantOperationsReader {
  constructor({ getConnection = getTenantConnection, maxTimeMS = DEFAULT_MAX_TIME_MS } = {}) {
    this.getConnection = getConnection;
    this.maxTimeMS = maxTimeMS;
  }

  async collection(tenantKey, name) {
    const connection = await this.getConnection(tenantKey);
    return connection.db.collection(name);
  }

  async run(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error?.code === MAX_TIME_EXPIRED || error?.codeName === 'MaxTimeMSExpired') {
        throw new PanelQueryTimeoutError();
      }
      throw error;
    }
  }

  async listEvents(tenantKey, { filters, skip = 0, limit = 25 } = {}) {
    const events = await this.collection(tenantKey, 'WebhookEvents');
    const filter = eventFilter(filters);
    return this.run(async () => {
      const [items, total] = await Promise.all([
        events
          .find(filter, { projection: EVENT_LIST_PROJECTION, maxTimeMS: this.maxTimeMS })
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        events.countDocuments(filter, { maxTimeMS: this.maxTimeMS }),
      ]);
      return { items, total };
    });
  }

  async findEvent(tenantKey, id, { withRaw = false, withExchange = false } = {}) {
    if (!isObjectId(id)) {
      return null;
    }
    const events = await this.collection(tenantKey, 'WebhookEvents');
    return this.run(() => events.findOne(
      { _id: toObjectId(id) },
      { projection: eventProjection({ withRaw, withExchange }), maxTimeMS: this.maxTimeMS }
    ));
  }

  async listSyncs(tenantKey, { filters, skip = 0, limit = 25 } = {}) {
    const syncs = await this.collection(tenantKey, 'SyncLogs');
    const filter = syncFilter(filters);
    return this.run(async () => {
      const [items, total] = await Promise.all([
        syncs
          .find(filter, { projection: SYNC_FIELDS, maxTimeMS: this.maxTimeMS })
          .sort({ startedAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        syncs.countDocuments(filter, { maxTimeMS: this.maxTimeMS }),
      ]);
      return { items, total };
    });
  }

  // Los errores se paginan dentro del documento con $slice y se cuentan con $size: nunca se
  // trae el array entero.
  async findSync(tenantKey, id, { errorsSkip = 0, errorsLimit = 0 } = {}) {
    if (!isObjectId(id)) {
      return null;
    }
    const syncs = await this.collection(tenantKey, 'SyncLogs');
    const errors = { $ifNull: ['$errors', []] };
    const project = { ...SYNC_FIELDS, errorsTotal: { $size: errors } };
    if (errorsLimit > 0) {
      project.errors = { $slice: [errors, errorsSkip, errorsLimit] };
    }
    const [document] = await this.run(() => syncs
      .aggregate([{ $match: { _id: toObjectId(id) } }, { $project: project }], { maxTimeMS: this.maxTimeMS })
      .toArray());
    if (!document) {
      return null;
    }
    const { errorsTotal, ...sync } = document;
    return { sync, errorsTotal };
  }

  // Eventos con createdAt en [from, to), sin reportes. Trae hasta limit + 1 para saber si el
  // período se pasó del tope sin contar aparte.
  async listEventsForSummary(tenantKey, { from, to, limit }) {
    const events = await this.collection(tenantKey, 'WebhookEvents');
    const items = await this.run(() => events
      .aggregate([
        { $match: { createdAt: { $gte: from, $lt: to }, status: { $ne: 'report' } } },
        { $limit: limit + 1 },
        { $project: SUMMARY_PROJECTION },
      ], { maxTimeMS: this.maxTimeMS })
      .toArray());
    return { items: items.slice(0, limit), truncated: items.length > limit };
  }

  // Plan 5b: eventos con error de esos negocios actualizados en la ventana de la corrida.
  // Solo id y referencia. La referencia puede estar guardada como texto o como número.
  async findQueueEventIds(tenantKey, { references = [], from, to } = {}) {
    const values = [];
    for (const reference of new Set(references.filter((value) => typeof value === 'string' && value))) {
      values.push(reference);
      if (/^\d+$/.test(reference) && Number.isSafeInteger(Number(reference))) {
        values.push(Number(reference));
      }
    }
    if (values.length === 0 || !from || !to) {
      return [];
    }
    const events = await this.collection(tenantKey, 'WebhookEvents');
    const documents = await this.run(() => events
      .find(
        { status: 'errored', 'payload.deal.hs_object_id': { $in: values }, updatedAt: { $gte: from, $lte: to } },
        { projection: { 'payload.deal.hs_object_id': 1 }, maxTimeMS: this.maxTimeMS }
      )
      .limit(500)
      .toArray());
    return documents.map((document) => ({
      id: String(document._id),
      reference: String(document.payload?.deal?.hs_object_id),
    }));
  }

  async findTasks(tenantKey, ids = []) {
    const valid = [...new Set(ids.map(String).filter(isObjectId))];
    if (valid.length === 0) {
      return [];
    }
    const tasks = await this.collection(tenantKey, 'ClientConfigs');
    return this.run(() => tasks
      .find({ _id: { $in: valid.map(toObjectId) } }, { projection: TASK_PROJECTION, maxTimeMS: this.maxTimeMS })
      .toArray());
  }

  async listTasks(tenantKey) {
    const tasks = await this.collection(tenantKey, 'ClientConfigs');
    return this.run(() => tasks
      .find({}, { projection: TASK_PROJECTION, maxTimeMS: this.maxTimeMS })
      .sort({ clientName: 1, _id: 1 })
      .toArray());
  }

  // Todos los mapeos de campos del tenant (activos e inactivos), ordenados. Devuelve
  // { items, truncated }: truncated es true si había más que MAX_FIELD_MAPPINGS.
  async listFieldMappings(tenantKey) {
    const mappings = await this.collection(tenantKey, 'FieldMappings');
    const documents = await this.run(() => mappings
      .find({}, { projection: FIELD_MAPPING_PROJECTION, maxTimeMS: this.maxTimeMS })
      .sort(FIELD_MAPPING_SORT)
      .limit(MAX_FIELD_MAPPINGS + 1)
      .toArray());
    return { items: documents.slice(0, MAX_FIELD_MAPPINGS), truncated: documents.length > MAX_FIELD_MAPPINGS };
  }

  // Todas las tareas (ClientConfigs) del tenant, activas primero y por nombre. Devuelve
  // { items, truncated }: truncated es true si había más que MAX_SCHEDULED_TASKS.
  async listScheduledTasks(tenantKey) {
    const tasks = await this.collection(tenantKey, 'ClientConfigs');
    const documents = await this.run(() => tasks
      .find({}, { projection: SCHEDULED_TASK_PROJECTION, maxTimeMS: this.maxTimeMS })
      .sort(SCHEDULED_TASK_SORT)
      .limit(MAX_SCHEDULED_TASKS + 1)
      .toArray());
    return { items: documents.slice(0, MAX_SCHEDULED_TASKS), truncated: documents.length > MAX_SCHEDULED_TASKS };
  }
}

export default TenantOperationsReader;
