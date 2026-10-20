// Forma genérica de eventos y corridas de sync para el panel (contrato 03, E1 a E6).
// Los nombres internos de estados y tipos no salen tal cual: se traducen aquí. La usa el
// contexto de los tickets (snapshot) y la podrá reusar el plan 3 (Eventos y syncs).

import { classifyError } from './errorCauses.js';
import { clientErrorText, sanitizeErrorText } from './errorText.js';
import { isQueueErrorList, queueRunSummary } from './queueRunErrors.js';

// Quién mira (plan 5, A3): al cliente le llegan los textos de error saneados y los errores de las
// corridas resumidos; a Smarteam, crudos. El dato guardado no cambia. Por defecto, cliente: lo
// más seguro si alguien se olvida de pasar el lado.
export const VIEW_SIDES = Object.freeze({ CLIENTE: 'cliente', SMARTEAM: 'smarteam' });

// Corridas sin tarea: las vueltas del procesador de la cola de webhooks (plan 5, A1).
export const EVENT_QUEUE_TASK_ID = 'event_queue';
export const EVENT_QUEUE_TASK = Object.freeze({ id: EVENT_QUEUE_TASK_ID, name: 'Cola de eventos', type: 'event_queue' });

// E1. Estado interno de WebhookEvent → estado genérico. 'report' no tiene equivalente.
export const EVENT_STATUS_MAP = Object.freeze({
  waiting: 'waiting',
  inprocess: 'in_process',
  sap_order_created: 'destination_created',
  sap_created_hubspot_error: 'destination_created_origin_error',
  completed: 'completed',
  errored: 'errored',
});

// E1 al revés: el filtro ?status= usa el valor genérico y la base el interno.
export const EVENT_STATUS_FROM_API = Object.freeze(
  Object.fromEntries(Object.entries(EVENT_STATUS_MAP).map(([internal, api]) => [api, internal]))
);

// Estado interno que nunca sale: reportes de calidad de datos (pestaña propia en la Fase 2).
export const HIDDEN_EVENT_STATUS = 'report';

// E6. Estados de una corrida; 'running' es el interno null (la corrida no terminó).
export const SYNC_STATUS_VALUES = Object.freeze(['completed', 'errored', 'running']);

// E5. Tipo interno de tarea → tipo genérico. Sin taskType, la tarea es la de registros.
export const SYNC_TASK_TYPE_MAP = Object.freeze({
  SAP_SYNC: 'record_sync',
  DROPDOWN_OPTIONS: 'dropdown_options',
});

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toId(value) {
  return value === undefined || value === null ? null : String(value);
}

// Los reportes de calidad no son eventos del panel. Un estado sin traducción sí se muestra,
// con status null (quien llama lo loguea para agregarlo al mapa).
export function isVisibleEvent(raw) {
  return Boolean(raw) && raw.status !== HIDDEN_EVENT_STATUS;
}

export function eventStatusToApi(status) {
  return Object.prototype.hasOwnProperty.call(EVENT_STATUS_MAP, status) ? EVENT_STATUS_MAP[status] : null;
}

// Evento genérico. Sin withRaw (cliente y staff sin staff.events.raw), payload y audit no
// existen ni como claves. cause: causa del último error (F5), o null si no hay error.
export function toEventView(raw, { withRaw = false, side = VIEW_SIDES.CLIENTE } = {}) {
  if (!isVisibleEvent(raw)) {
    return null;
  }

  const reference = raw.payload?.deal?.hs_object_id;
  const view = {
    id: toId(raw._id ?? raw.id),
    type: raw.eventType ?? null,
    status: eventStatusToApi(raw.status),
    retries: raw.retries ?? 0,
    maxRetries: raw.maxRetries ?? null,
    lastError: side === VIEW_SIDES.SMARTEAM ? (raw.lastError ?? null) : clientErrorText(raw.lastError),
    cause: raw.lastError ? classifyError(raw.lastError) : null,
    reference: reference === undefined || reference === null ? null : String(reference),
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
  };
  if (withRaw) {
    view.payload = raw.payload ?? null;
    view.audit = raw.sapAudit ?? null;
  }
  return view;
}

// E6: completed, errored o running (interno null). Un valor desconocido no sale tal cual.
export function syncStatusToApi(status) {
  if (status === null || status === undefined) {
    return 'running';
  }
  return status === 'completed' || status === 'errored' ? status : null;
}

export function toSyncTaskView(rawTask) {
  if (!rawTask) {
    return null;
  }
  return {
    id: toId(rawTask._id ?? rawTask.id),
    name: rawTask.clientName ?? null,
    type: SYNC_TASK_TYPE_MAP[rawTask.taskType ?? 'SAP_SYNC'] ?? null,
  };
}

// errorMessage de una corrida para el cliente: un texto se sanea; un objeto o lista (por ejemplo
// las entradas con payloads y respuestas del procesador de webhooks) se resume sin su contenido.
export function clientSyncErrorMessage(errorMessage) {
  if (errorMessage === null || errorMessage === undefined) {
    return null;
  }
  if (typeof errorMessage === 'string') {
    return clientErrorText(errorMessage);
  }
  // Corridas de la cola de eventos (plan 5b): el resumen lleva el primer mensaje, saneado.
  if (isQueueErrorList(errorMessage)) {
    return { summary: queueRunSummary(errorMessage) };
  }
  const count = Array.isArray(errorMessage) ? errorMessage.length : 1;
  return { summary: `${count} error(es) en la corrida` };
}

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) ?? null;
}

// Un error de la corrida para el cliente: solo el registro y el mensaje, saneado.
export function clientSyncErrorItem(item) {
  if (typeof item === 'string') {
    return { record: null, message: clientErrorText(item) };
  }
  if (!item || typeof item !== 'object') {
    return { record: null, message: null };
  }
  const record = [item.record, item.recordId, item.itemCode, item.id]
    .find((value) => typeof value === 'string' || typeof value === 'number');
  const message = firstText(item.message, item.error?.message, item.error, item.reason);
  return {
    record: record === undefined ? null : sanitizeErrorText(String(record).slice(0, 200)),
    message: clientErrorText(message),
  };
}

function syncTask(raw, rawTask) {
  if (!raw.clientConfigId) {
    return { ...EVENT_QUEUE_TASK };
  }
  return toSyncTaskView(rawTask);
}

// Corrida de sync sin la lista de errores (E5, E6).
export function toSyncView(raw, rawTask = null, { side = VIEW_SIDES.CLIENTE } = {}) {
  if (!raw) {
    return null;
  }

  return {
    id: toId(raw._id ?? raw.id),
    task: syncTask(raw, rawTask),
    objectType: raw.objectType ? String(raw.objectType).toLowerCase() : null,
    status: syncStatusToApi(raw.status),
    counts: {
      processed: raw.recordsProcessed ?? 0,
      sent: raw.sent ?? 0,
      failed: raw.failed ?? 0,
      updated: raw.updated ?? 0,
      skipped: raw.skipped ?? 0,
    },
    skippedReasons: Array.isArray(raw.skippedReasons)
      ? raw.skippedReasons
        .filter((entry) => entry && typeof entry === 'object')
        .map(({ reason, count }) => ({ reason: typeof reason === 'string' ? reason.slice(0, 200) : null, count: count ?? 0 }))
      : [],
    errorMessage: side === VIEW_SIDES.SMARTEAM ? (raw.errorMessage ?? null) : clientSyncErrorMessage(raw.errorMessage),
    startedAt: toIso(raw.startedAt),
    finishedAt: toIso(raw.finishedAt),
  };
}
