// Causas de error (contrato 05, F5): catálogo propio del backend. Cada regla es una expresión
// sobre el lastError del evento → causa con etiqueta genérica (sin nombres de sistemas) y un
// grupo fijo. El panel no clasifica: solo dibuja lo que llega. Gana la primera regla que calza.
// Arranca con las reglas de la API simulada del front; se afina con el diagnóstico
// (scripts/panel-operations-report.mjs) sobre los textos reales de cada tenant.

// Grupos fijos del contrato, en el orden en que el panel los presenta.
export const CAUSE_GROUPS = Object.freeze([
  'deal_data',
  'fiscal_data',
  'destination_validation',
  'master_blocked',
  'connectivity',
  'other',
]);

export const OTHER_CAUSE = Object.freeze({ key: 'other', label: 'Otro error', group: 'other' });

export const ERROR_CAUSES = Object.freeze([
  { key: 'fiscal_id_incomplete', label: 'Identificación fiscal incompleta', group: 'fiscal_data', pattern: /identificaci[oó]n fiscal/i },
  { key: 'customer_inactive', label: 'Cliente o prospecto inactivo', group: 'master_blocked', pattern: /(cliente|prospecto)\b.*\binactivo/i },
  { key: 'customer_without_code', label: 'Cliente sin código en destino', group: 'master_blocked', pattern: /no tiene c[oó]digo/i },
  { key: 'no_line_items', label: 'Negocio sin líneas de producto', group: 'deal_data', pattern: /l[ií]neas de producto/i },
  { key: 'missing_company_contact', label: 'Negocio sin empresa ni contacto', group: 'deal_data', pattern: /sin empresa ni contacto/i },
  { key: 'value_too_long', label: 'Valor demasiado largo en el contacto', group: 'deal_data', pattern: /demasiado largo/i },
  { key: 'price_list_unmapped', label: 'Lista de precios sin mapear', group: 'deal_data', pattern: /lista de precios/i },
  { key: 'payment_terms_mismatch', label: 'Condición de pago no coincide', group: 'destination_validation', pattern: /condici[oó]n de pago/i },
  { key: 'invalid_subgroup', label: 'Subgrupo no válido para el cliente', group: 'destination_validation', pattern: /subgrupo/i },
  { key: 'item_not_found', label: 'Artículo inexistente en destino', group: 'destination_validation', pattern: /art[ií]culo\b.*\bno existe/i },
  { key: 'timeout', label: 'Tiempo de espera agotado', group: 'connectivity', pattern: /\bE?SOCKETTIMEDOUT\b|\bETIMEDOUT\b|\btimeout\b|tiempo de espera/i },
  { key: 'connection_failed', label: 'No se pudo conectar con el sistema destino', group: 'connectivity', pattern: /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|socket hang up|conexi[oó]n rechazada/i },
].map((rule) => Object.freeze(rule)));

// Causa de un texto de error: { key, label, group }.
// Corte previo a las expresiones: un texto enorme no puede bloquear el proceso (ReDoS).
const MAX_CLASSIFY_LENGTH = 2000;

export function classifyError(message) {
  const text = typeof message === 'string' ? message.slice(0, MAX_CLASSIFY_LENGTH) : '';
  const rule = text ? ERROR_CAUSES.find((cause) => cause.pattern.test(text)) : null;
  return rule ? { key: rule.key, label: rule.label, group: rule.group } : { ...OTHER_CAUSE };
}
