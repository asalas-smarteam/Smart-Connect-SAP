import { SYNC_TASK_TYPE_MAP, VIEW_SIDES } from './operationViews.js';
import { clientErrorText } from './errorText.js';

// Zona del programador de syncs. Copia de SAP_SYNC_SCHEDULER_TIMEZONE
// (src/infrastructure/scheduler/sapSyncScheduler.service.js), que no se exporta: una prueba
// compara las dos para que no queden desalineadas.
export const SCHEDULER_TIME_ZONE = 'America/Costa_Rica';

const URL_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

function text(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value);
}

function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Igual que el programador: cualquier valor que no sea FULL se trata como INCREMENTAL.
function modeOf(value) {
  return String(value || 'INCREMENTAL').trim().toUpperCase() === 'FULL' ? 'full' : 'incremental';
}

function lower(value) {
  const result = text(value);
  return result === null ? null : result.toLowerCase();
}

// Resguardo para el cliente: si la ruta trae esquema y host, se entrega solo la ruta.
function clientPath(path) {
  if (path === null || !path.includes('://')) {
    return path;
  }
  return path.replace(URL_PREFIX, '') || null;
}

function toFilterView(filter) {
  const isDynamic = flag(filter.isDynamic, false);
  return {
    property: text(filter.property),
    operator: text(filter.operator),
    value: filter.value === undefined ? null : filter.value,
    isDefault: flag(filter.isDefault, false),
    isDynamic,
    // En la base vale 'datetime' por defecto aunque el filtro no sea dinámico.
    dynamicType: isDynamic ? (text(filter.dynamicType) ?? 'datetime') : null,
    editable: flag(filter.editable, true),
  };
}

function toOrderByView(order) {
  return { property: text(order.property), direction: order.direction === 'asc' ? 'asc' : 'desc' };
}

function objects(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : [];
}

// Vista de una tarea programada (ClientConfig) para el panel (plan 7, contrato 09, J2). Solo sale
// la lista de J2; si falta un campo, el default del esquema. lastError: crudo para Smarteam,
// saneado para el cliente (G4).
export function toScheduledTaskView(raw, { side = VIEW_SIDES.CLIENTE, nextRunAt = null } = {}) {
  if (!raw) {
    return null;
  }
  const id = raw._id ?? raw.id;
  const active = flag(raw.active, false);
  const sourcePath = text(raw.serviceLayerPath);
  const lastError = text(raw.lastError);
  const isClient = side !== VIEW_SIDES.SMARTEAM;
  const interval = Number.isFinite(raw.intervalMinutes) ? raw.intervalMinutes : null;

  return {
    id: id === undefined || id === null ? null : String(id),
    name: text(raw.clientName),
    type: SYNC_TASK_TYPE_MAP[raw.taskType ?? 'SAP_SYNC'] ?? null,
    objectType: lower(raw.objectType),
    sourcePath: isClient ? clientPath(sourcePath) : sourcePath,
    mode: modeOf(raw.mode),
    schedule: {
      intervalMinutes: interval,
      times: Array.isArray(raw.executionTime) ? raw.executionTime.map(String) : [],
      days: Array.isArray(raw.executionDays) ? raw.executionDays.map((day) => String(day).toLowerCase()) : [],
      startTime: text(raw.startTime),
      endTime: text(raw.endTime),
      timeZone: SCHEDULER_TIME_ZONE,
    },
    batchSize: Number.isFinite(raw.hubspotBatchSize) ? raw.hubspotBatchSize : 1,
    associationsEnabled: flag(raw.associationFetchEnabled, false),
    requireCrmIdUpdate: flag(raw.requireUpdateHubspotID, false),
    filters: objects(raw.filters).map(toFilterView),
    orderBy: objects(raw.orderBy).map(toOrderByView),
    active,
    lastRunAt: toIso(raw.lastRun),
    lastError: isClient ? clientErrorText(lastError) : lastError,
    // Solo una tarea activa tiene próxima ejecución.
    nextRunAt: active ? toIso(nextRunAt) : null,
  };
}
