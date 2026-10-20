import { clientErrorText } from './errorText.js';

// Corridas de la cola de eventos (plan 5b): el procesador de webhooks guarda el detalle de cada
// fallo en errorMessage como una lista de entradas { payload_Hubspot, payload_SAP,
// response_hubspot, response_SAP } (buildWebhookSyncErrorEntry) y deja errors vacío. El panel
// deriva de ahí los ítems de errors, sin cambiar lo guardado.

export const QUEUE_ENTRY_KEYS = Object.freeze(['payload_Hubspot', 'payload_SAP', 'response_hubspot', 'response_SAP']);
export const NO_DETAIL_MESSAGE = 'Error sin detalle';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isQueueEntry(item) {
  return isPlainObject(item) && QUEUE_ENTRY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(item, key));
}

export function isQueueErrorList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isQueueEntry);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Id del negocio: payload del webhook ({ deal: { hs_object_id } }) o precios por lista ({ dealId }).
export function queueEntryRecord(entry) {
  const payload = isPlainObject(entry?.payload_Hubspot) ? entry.payload_Hubspot : null;
  const value = payload?.deal?.hs_object_id ?? payload?.dealId ?? null;
  return value === null || value === undefined || value === '' || typeof value === 'object' ? null : String(value);
}

// Mensaje crudo: response_SAP.message (camino genérico), response_SAP.error.message (casos de
// uso) y, si no hay, lo mismo en response_hubspot.
export function queueEntryMessage(entry) {
  const sap = isPlainObject(entry?.response_SAP) ? entry.response_SAP : null;
  const crm = isPlainObject(entry?.response_hubspot) ? entry.response_hubspot : null;
  return text(sap?.message)
    ?? text(sap?.error?.message)
    ?? text(crm?.message)
    ?? text(crm?.error?.message)
    ?? null;
}

// Ítem de errors para la vista: el cliente recibe el mensaje saneado; Smarteam, crudo.
export function deriveQueueErrorItem(entry, { side = 'cliente', eventId = null } = {}) {
  const raw = queueEntryMessage(entry);
  const message = side === 'smarteam'
    ? (raw ?? NO_DETAIL_MESSAGE)
    : (clientErrorText(raw) ?? NO_DETAIL_MESSAGE);
  return { record: queueEntryRecord(entry), message, eventId: eventId ?? null };
}

// Resumen para el cliente: "1 error en la corrida: <mensaje>" / "3 errores en la corrida: <mensaje>".
export function queueRunSummary(entries) {
  const count = entries.length;
  const first = clientErrorText(queueEntryMessage(entries[0]));
  if (!first) {
    return `${count} error(es) en la corrida`;
  }
  return `${count} ${count === 1 ? 'error' : 'errores'} en la corrida: ${first}`;
}
