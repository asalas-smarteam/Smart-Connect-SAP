import { EVENT_QUEUE_TASK_ID, EVENT_STATUS_FROM_API, SYNC_STATUS_VALUES } from '#domain/panel/operationViews.js';
import { validationError } from './panelReasons.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DIGITS = /^\d+$/;

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

// Un filtro de la query: ausente, o un texto. Un array u objeto (?status=a&status=b) no vale.
function readText(query, name) {
  const value = query[name];
  if (!isPresent(value)) {
    return { ok: true, value: undefined };
  }
  return typeof value === 'string' ? { ok: true, value } : { ok: false };
}

// E3: from inclusivo, to exclusivo, en ISO 8601. Fecha inválida → 400.
function readDateRange(query) {
  const from = readText(query, 'from');
  const to = readText(query, 'to');
  if (!from.ok || !to.ok) {
    return null;
  }
  const range = {};
  for (const [name, read] of [['from', from], ['to', to]]) {
    if (read.value !== undefined) {
      const ms = Date.parse(read.value);
      if (Number.isNaN(ms)) {
        return null;
      }
      range[name] = new Date(ms);
    }
  }
  return range;
}

// Filtros de eventos (E1 a E4), ya traducidos a los valores internos.
export function parseEventFilters(query = {}) {
  const status = readText(query, 'status');
  if (!status.ok || (status.value !== undefined && !Object.prototype.hasOwnProperty.call(EVENT_STATUS_FROM_API, status.value))) {
    return validationError('Estado inválido.');
  }
  const type = readText(query, 'type');
  if (!type.ok) {
    return validationError('Tipo inválido.');
  }
  const reference = readText(query, 'reference');
  if (!reference.ok) {
    return validationError('Referencia inválida.');
  }
  const range = readDateRange(query);
  if (!range) {
    return validationError('Fecha inválida.');
  }

  const filters = { ...range };
  if (status.value !== undefined) {
    filters.status = EVENT_STATUS_FROM_API[status.value];
  }
  if (type.value !== undefined) {
    filters.type = type.value;
  }
  if (reference.value !== undefined) {
    // El id del negocio puede estar guardado como texto o como número según el origen.
    const values = [reference.value];
    if (DIGITS.test(reference.value) && Number.isSafeInteger(Number(reference.value))) {
      values.push(Number(reference.value));
    }
    filters.references = values;
  }
  return { ok: true, filters };
}

// Filtros de syncs (E5, E6): status completed | errored | running (= null interno).
export function parseSyncFilters(query = {}) {
  const status = readText(query, 'status');
  if (!status.ok || (status.value !== undefined && !SYNC_STATUS_VALUES.includes(status.value))) {
    return validationError('Estado inválido.');
  }
  const taskId = readText(query, 'taskId');
  if (!taskId.ok || (taskId.value !== undefined && taskId.value !== EVENT_QUEUE_TASK_ID && !OBJECT_ID.test(taskId.value))) {
    return validationError('Tarea inválida.');
  }
  // Plan 5 (G2): solo corridas con registros procesados.
  const hideEmpty = readText(query, 'hideEmpty');
  if (!hideEmpty.ok || (hideEmpty.value !== undefined && hideEmpty.value !== 'true' && hideEmpty.value !== 'false')) {
    return validationError('Filtro inválido.');
  }
  const range = readDateRange(query);
  if (!range) {
    return validationError('Fecha inválida.');
  }

  const filters = { ...range };
  if (status.value !== undefined) {
    filters.status = status.value === 'running' ? null : status.value;
    filters.hasStatus = true;
  }
  if (taskId.value === EVENT_QUEUE_TASK_ID) {
    // Corridas de la cola de eventos: las que no tienen tarea (G1).
    filters.eventQueue = true;
  } else if (taskId.value !== undefined) {
    filters.taskId = taskId.value;
  }
  if (hideEmpty.value === 'true') {
    filters.hideEmpty = true;
  }
  return { ok: true, filters };
}
