// Registro de trabajo de Smarteam sobre un ticket (contrato 12, M5 y M6).
// Funciones puras: validan y normalizan el cuerpo, arman la fuente de la huella de idempotencia
// y la vista del registro para el detalle de Smarteam. El cliente nunca ve nada de esto.
import { checkRequiredText } from './tickets.js';

export const WORK_LOG_LIMITS = Object.freeze({
  SUMMARY_MAX: 5000,
  INTERNAL_NOTE_MAX: 5000,
  HOURS_MIN: 0.25,
  HOURS_MAX: 24,
  HOURS_STEP: 0.25,
  CRM_PROJECT_ID_MAX: 64,
});

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const CRM_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const WORK_LOG_MESSAGES = Object.freeze({
  INTERNAL_NOTE_NOT_TEXT: 'La nota interna debe ser texto.',
  INTERNAL_NOTE_TOO_LONG: `La nota interna supera los ${WORK_LOG_LIMITS.INTERNAL_NOTE_MAX} caracteres.`,
  INTERNAL_NOTE_REQUIRED: 'La nota interna es obligatoria para resolver.',
  HOURS: 'Las horas deben ir de 0.25 a 24, en cuartos de hora.',
  RESOLVE: 'resolve debe ser verdadero o falso.',
  CRM_PROJECT_ID: 'El id del proyecto del CRM debe tener hasta 64 caracteres: letras, números, guion bajo o guion.',
  IDEMPOTENCY_KEY: 'Idempotency-Key debe tener de 1 a 128 caracteres: letras, números, punto, guion bajo, dos puntos o guion.',
});

const M = WORK_LOG_MESSAGES;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Texto opcional: ausente, null, vacío o de solo espacios → null.
function optionalText(value) {
  if (value === undefined || value === null) {
    return { ok: true, text: null };
  }
  if (typeof value !== 'string') {
    return { ok: false };
  }
  const text = value.trim();
  return { ok: true, text: text || null };
}

// Número JSON (no texto) entre 0.25 y 24, múltiplo de 0.25. Los cuartos son exactos en coma
// flotante, así que las sumas del registro no acumulan error.
function isValidHours(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= WORK_LOG_LIMITS.HOURS_MIN
    && value <= WORK_LOG_LIMITS.HOURS_MAX
    && Number.isInteger(value * 4);
}

// Valida y normaliza el cuerpo de POST …/work-log (tabla de validaciones de M5). Los campos
// desconocidos se ignoran. Devuelve { ok: true, input } o { ok: false, message }.
export function checkWorkLogInput(body) {
  const source = isPlainObject(body) ? body : {};

  const summary = checkRequiredText(source.summary, { label: 'El resumen', max: WORK_LOG_LIMITS.SUMMARY_MAX });
  if (summary.message) {
    return { ok: false, message: summary.message };
  }

  const note = optionalText(source.internalNote);
  if (!note.ok) {
    return { ok: false, message: M.INTERNAL_NOTE_NOT_TEXT };
  }
  if (note.text !== null && note.text.length > WORK_LOG_LIMITS.INTERNAL_NOTE_MAX) {
    return { ok: false, message: M.INTERNAL_NOTE_TOO_LONG };
  }

  if (!isValidHours(source.hours)) {
    return { ok: false, message: M.HOURS };
  }

  const resolve = source.resolve === undefined ? false : source.resolve;
  if (typeof resolve !== 'boolean') {
    return { ok: false, message: M.RESOLVE };
  }
  if (resolve && note.text === null) {
    return { ok: false, message: M.INTERNAL_NOTE_REQUIRED };
  }

  const crm = optionalText(source.crmProjectId);
  if (!crm.ok || (crm.text !== null && !CRM_PROJECT_ID_PATTERN.test(crm.text))) {
    return { ok: false, message: M.CRM_PROJECT_ID };
  }

  return {
    ok: true,
    input: {
      summary: summary.text,
      internalNote: note.text,
      hours: source.hours,
      resolve,
      crmProjectId: crm.text,
    },
  };
}

// Header Idempotency-Key opcional. Sin recortar: un espacio la vuelve inválida.
export function checkIdempotencyKey(value) {
  if (value === undefined || value === null) {
    return { ok: true, key: null };
  }
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    return { ok: false, message: M.IDEMPOTENCY_KEY };
  }
  return { ok: true, key: value };
}

// Fuente de la huella (M5): JSON con llaves en orden fijo, sobre el código normalizado y los
// campos ya validados. El hash SHA-256 lo calcula quien la usa (fuera del dominio).
export function workLogFingerprintSource({ code, input }) {
  return JSON.stringify({
    code: String(code ?? '').trim().toUpperCase(),
    summary: input.summary,
    internalNote: input.internalNote ?? null,
    hours: input.hours,
    resolve: input.resolve === true,
    crmProjectId: input.crmProjectId ?? null,
  });
}

export function totalHours(entries) {
  return (entries ?? []).reduce((sum, entry) => sum + (Number(entry?.hours) || 0), 0);
}

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMs(value) {
  if (!value) {
    return 0;
  }
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function idString(value) {
  return value === undefined || value === null ? null : String(value);
}

// Una entrada tal como la ve Smarteam (detalle M6 y respuesta 201 de M5). No expone authorId,
// tokenId, idempotencyKey, via, statusAfter ni resolved.
export function toWorkLogEntryView(entry) {
  return {
    id: idString(entry.id ?? entry._id),
    author: { name: entry.authorName ?? null },
    hours: entry.hours,
    internalNote: entry.internalNote ?? null,
    crmProjectId: entry.crmProjectId ?? null,
    createdAt: toIso(entry.createdAt),
    messageId: idString(entry.messageId),
  };
}

// Registro completo del ticket: de la entrada más nueva a la más vieja, con el total de horas.
export function toWorkLogView(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const sorted = [...list].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  return {
    totalHours: totalHours(list),
    entries: sorted.map(toWorkLogEntryView),
  };
}
