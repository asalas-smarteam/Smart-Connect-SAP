import { classifyError } from './errorCauses.js';

// Textos de error para cuentas cliente (plan 5, A3). El dato guardado no cambia: esto solo
// decide qué entrega la API del panel a un cliente. Smarteam recibe el texto crudo.

const MAX_LENGTH = 500;
// Corte previo a las expresiones: un texto enorme no puede bloquear el proceso (ReDoS).
export const MAX_INPUT_LENGTH = 2000;

const REPLACEMENTS = [
  // Enlaces y correos primero: contienen hosts que si no se reemplazarían a medias.
  [/\b(?:https?|wss?|ftp):\/\/[^\s'"<>()]+/gi, '[enlace]'],
  [/\b[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi, '[correo]'],
  // Rutas de red y de archivos.
  [/\\\\[^\s]+/g, '[ruta]'],
  [/(?:^|(?<=\s))(?:\/[\w.-]+){2,}\/?/g, '[ruta]'],
  // IPv6 entre corchetes, IPv4 (con puerto opcional) e IPv6 (con "::" o 5+ grupos, para no
  // tocar horas como 10:30:00), con zona opcional (%eth0).
  [/\[[0-9a-f:.%\w]*:[0-9a-f:.%\w]*\](?::\d{1,5})?/gi, '[servidor]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[servidor]'],
  [/(?:\b[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b(?:%\w+)?|(?:\b[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:?){1,7}(?:%\w+)?/gi, '[servidor]'],
  // host:puerto (con o sin dominio) y nombres de servidor con dominio (última etiqueta con letras).
  [/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)+:\d{2,5}\b/gi, '[servidor]'],
  [/\b[a-z][a-z0-9_-]*:\d{4,5}\b/gi, '[servidor]'],
  [/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.[a-z]{2,24}\b/gi, '[servidor]'],
  // Bases de datos de la empresa en el ERP.
  [/\bSBO_\w+/g, '[base]'],
  // Nombres de sistemas: genéricos para el cliente.
  [/\bSAP(?:\s+(?:Business\s+One|B1|S\/4\s?HANA|Service\s+Layer))?\b/gi, 'el ERP'],
  [/\bHub\s?Spot\b/gi, 'el CRM'],
];

// Prefijos técnicos al inicio: "AxiosError: ", "Error: ", "MongoServerError: ".
const TECHNICAL_PREFIX = /^(?:\s*[A-Za-z]*Error:\s*)+/;

export function sanitizeErrorText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  let result = text.slice(0, MAX_INPUT_LENGTH).replace(TECHNICAL_PREFIX, '');
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(/\s+/g, ' ').trim();
  if (result.length > MAX_LENGTH) {
    result = `${result.slice(0, MAX_LENGTH - 1)}…`;
  }
  return result || null;
}

// Texto que ve un cliente: si es de conectividad, la etiqueta legible; si no, el texto saneado.
export function clientErrorText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  const cause = classifyError(text);
  if (cause.group === 'connectivity') {
    return `${cause.label}.`;
  }
  return sanitizeErrorText(text);
}
