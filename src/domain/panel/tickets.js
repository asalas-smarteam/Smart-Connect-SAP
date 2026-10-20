// Reglas de los tickets de soporte del panel (spec §2 Soporte y contrato 02-soporte.md).
// Funciones puras: sin base de datos, sin HTTP y sin reloj propio (la fecha llega de afuera).

export const TICKET_STATUSES = Object.freeze({
  ABIERTO: 'abierto',
  EN_PROGRESO: 'en_progreso',
  ESPERANDO_CLIENTE: 'esperando_cliente',
  RESUELTO: 'resuelto',
});

export const TICKET_STATUS_VALUES = Object.freeze(Object.values(TICKET_STATUSES));

export const TICKET_CATEGORIES = Object.freeze([
  'sincronizacion',
  'documentos',
  'precios',
  'mapeos',
  'acceso',
  'otro',
]);

// Contexto opcional al crear: un evento o una corrida de sync del mismo tenant (contrato D11).
export const TICKET_CONTEXT_TYPES = Object.freeze({
  WEBHOOK_EVENT: 'webhookEvent',
  SYNC_LOG: 'syncLog',
});

export const TICKET_CONTEXT_TYPE_VALUES = Object.freeze(Object.values(TICKET_CONTEXT_TYPES));

// Quién escribe o cambia el estado. 'ia' queda reservado y no se usa en la Fase 1.
export const TICKET_SIDES = Object.freeze({
  CLIENTE: 'cliente',
  SMARTEAM: 'smarteam',
});

export const TICKET_LIMITS = Object.freeze({
  TITLE_MAX: 150,
  TEXT_MAX: 5000,
  MAX_IMAGES: 5,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  // Bandeja de Smarteam: page × pageSize no puede pasar de aquí (contrato D9).
  INBOX_PAGE_WINDOW: 1000,
});

const S = TICKET_STATUSES;

export function isTicketStatus(value) {
  return typeof value === 'string' && TICKET_STATUS_VALUES.includes(value);
}

export function isTicketCategory(value) {
  return typeof value === 'string' && TICKET_CATEGORIES.includes(value);
}

export function isTicketContextType(value) {
  return typeof value === 'string' && TICKET_CONTEXT_TYPE_VALUES.includes(value);
}

// ---------- Transiciones (spec §2, tabla de transiciones) ----------
// Cada función devuelve el estado que queda, o null si la acción no está permitida (409).

// Mensaje del cliente: esperando_cliente → en_progreso; en resuelto no se puede (se reabre).
export function statusAfterClientMessage(status) {
  if (!isTicketStatus(status) || status === S.RESUELTO) {
    return null;
  }
  return status === S.ESPERANDO_CLIENTE ? S.EN_PROGRESO : status;
}

// Mensaje de Smarteam: el primero sobre un ticket abierto lo pasa a en_progreso.
export function statusAfterStaffMessage(status) {
  if (!isTicketStatus(status) || status === S.RESUELTO) {
    return null;
  }
  return status === S.ABIERTO ? S.EN_PROGRESO : status;
}

// Cambio manual de Smarteam: abierto → en_progreso, en_progreso → esperando_cliente y
// resuelto → en_progreso. Tomar un ticket abierto no marca la primera respuesta: firstResponseAt
// solo lo fija el primer mensaje de Smarteam.
const STAFF_MANUAL_TRANSITIONS = Object.freeze([
  [S.ABIERTO, S.EN_PROGRESO],
  [S.EN_PROGRESO, S.ESPERANDO_CLIENTE],
  [S.RESUELTO, S.EN_PROGRESO],
]);

export function canStaffSetStatus(from, to) {
  return STAFF_MANUAL_TRANSITIONS.some(([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to);
}

// Resolver: desde cualquier estado menos resuelto.
export function canResolve(status) {
  return isTicketStatus(status) && status !== S.RESUELTO;
}

// "Sigue fallando": solo un ticket resuelto, y vuelve a abierto.
export function statusAfterReopen(status) {
  return status === S.RESUELTO ? S.ABIERTO : null;
}

// ---------- Novedades ----------
// Hay novedad si la última actividad es posterior a la última vista de ese lado y el último
// mensaje público es del otro lado. Es por ticket, no por usuario.
function isAfter(value, reference) {
  if (!value) {
    return false;
  }
  if (!reference) {
    return true;
  }
  return new Date(value).getTime() > new Date(reference).getTime();
}

export function hasNewsFor(ticket, side) {
  if (side === TICKET_SIDES.CLIENTE) {
    return ticket.lastPublicAuthorType === TICKET_SIDES.SMARTEAM
      && isAfter(ticket.lastActivityAt, ticket.clientLastSeenAt);
  }

  return ticket.lastPublicAuthorType === TICKET_SIDES.CLIENTE
    && isAfter(ticket.lastActivityAt, ticket.staffLastSeenAt);
}

// ---------- Código visible ----------
// tenantKey real: '<prefijo>_<slug>' (por ejemplo sap_integration_printer) → 'PRINTER-0007'.
export function ticketCodePrefix(tenantKey, tenantDbPrefix) {
  const key = String(tenantKey ?? '');
  const prefix = tenantDbPrefix ? `${tenantDbPrefix}_` : '';
  const slug = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return slug.toUpperCase();
}

export function ticketCode(tenantKey, number, tenantDbPrefix) {
  return `${ticketCodePrefix(tenantKey, tenantDbPrefix)}-${String(number).padStart(4, '0')}`;
}

// ---------- Textos ----------
// Texto obligatorio con largo máximo, recortado. Devuelve { text } o { message } para el usuario.
export function checkRequiredText(value, { label, max }) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return { message: `${label} es obligatorio.` };
  }
  if (text.length > max) {
    return { message: `${label} supera los ${max} caracteres.` };
  }
  return { text };
}
