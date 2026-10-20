// Intercambio de un evento (plan 5c, contrato 07, H1): lo recibido del CRM (payload), lo enviado
// al ERP (sapAudit.payloadSap) y su respuesta (sapAudit.responseSap). Solo en el detalle.
// Para el cliente se sanea una COPIA: lo guardado no cambia.

const MAX_DEPTH = 20;
const MAX_TEXT = 5000;
const MAX_ITEMS = 1000;
const TRUNCATED = '[…]';

// Claves que nunca van al cliente, a cualquier profundidad (sin distinguir mayúsculas).
// Credenciales: por subcadena las inequívocas; por nombre exacto las cortas.
const CREDENTIAL_SUBSTRING = /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i;
const CREDENTIAL_EXACT = /^(?:pwd|pass|pin|auth|authorization|cookie|session|session[_-]?id)$/i;
// Rutas y hosts internos.
const ROUTE_EXACT = /^(?:sapcalls|path|url|uri|endpoint|host|hostname|base[_-]?url|service[_-]?layer[_-]?url)$/i;
const ODATA = /^(?:@odata|odata\.)/i;

export function isHiddenKey(key) {
  return CREDENTIAL_SUBSTRING.test(key)
    || CREDENTIAL_EXACT.test(key)
    || ROUTE_EXACT.test(key)
    || ODATA.test(key);
}

// Textos: solo IPs, host:puerto y URLs. Correos, direcciones y nombres son datos del cliente.
const TEXT_MASKS = [
  [/\b(?:https?|wss?|ftp):\/\/[^\s'"<>()]+/gi, '[enlace]'],
  [/\[[0-9a-f:.%\w]*:[0-9a-f:.%\w]*\](?::\d{1,5})?/gi, '[servidor]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[servidor]'],
  [/(?:\b[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b(?:%\w+)?|(?:\b[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:?){1,7}(?:%\w+)?/gi, '[servidor]'],
  [/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)+:\d{2,5}\b/gi, '[servidor]'],
];

function maskText(text) {
  let result = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}${TRUNCATED}` : text;
  for (const [pattern, replacement] of TEXT_MASKS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// Copia saneada para el cliente.
export function sanitizeForClient(value, depth = 0) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === 'string') {
    return maskText(value);
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitizeForClient(item, depth + 1));
    if (value.length > MAX_ITEMS) {
      items.push(TRUNCATED);
    }
    return items;
  }
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isHiddenKey(key)) {
      result[key] = sanitizeForClient(nested, depth + 1);
    }
  }
  return result;
}

function part(value) {
  return value === undefined ? null : value;
}

// { received, sent, response } desde el evento crudo; null si no hay ninguna parte.
export function buildExchange(raw) {
  const exchange = {
    received: part(raw?.payload),
    sent: part(raw?.sapAudit?.payloadSap),
    response: part(raw?.sapAudit?.responseSap),
  };
  if (exchange.received === null && exchange.sent === null && exchange.response === null) {
    return null;
  }
  return exchange;
}

// Vista por lado: Smarteam recibe el intercambio tal cual; el cliente, la copia saneada.
export function exchangeView(raw, { side = 'cliente' } = {}) {
  const exchange = buildExchange(raw);
  if (!exchange || side === 'smarteam') {
    return exchange;
  }
  return {
    received: sanitizeForClient(exchange.received),
    sent: sanitizeForClient(exchange.sent),
    response: sanitizeForClient(exchange.response),
  };
}
