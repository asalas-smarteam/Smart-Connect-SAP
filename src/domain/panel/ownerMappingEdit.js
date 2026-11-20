// Edición del mapeo de responsables desde el panel (plan 12, contrato 14, O2).
// Solo dos campos: el vendedor del ERP (erpOwnerId → sapOwnerId) y el empleado digitador
// (erpEmployeeId → sapOwnerId_2). Todo lo demás del cuerpo se rechaza con 400, no se ignora.

export const EDITABLE_OWNER_FIELDS = Object.freeze({
  erpOwnerId: 'sapOwnerId',
  erpEmployeeId: 'sapOwnerId_2',
});

const ALLOWED_KEYS = new Set([...Object.keys(EDITABLE_OWNER_FIELDS), 'expectedUpdatedAt']);
// Uno o varios códigos de vendedor separados por coma ("113,758,864").
const OWNER_CODES = /^\d+(,\d+)*$/;
const OWNER_CODES_MAX_LENGTH = 100;
// Un solo código de empleado, sin comas.
const EMPLOYEE_CODE = /^\d{1,18}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const LABELS = Object.freeze({
  erpOwnerId: 'El código de vendedor',
  erpEmployeeId: 'El código de empleado',
});

const RULES = Object.freeze({
  erpOwnerId: (value) => OWNER_CODES.test(value) && value.length <= OWNER_CODES_MAX_LENGTH,
  erpEmployeeId: (value) => EMPLOYEE_CODE.test(value),
});

const RULE_MESSAGES = Object.freeze({
  erpOwnerId: 'El código de vendedor debe ser un número o varios separados por coma (por ejemplo 113,758), de hasta 100 caracteres.',
  erpEmployeeId: 'El código de empleado debe ser un solo número entero, sin comas.',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// null o "" (también solo espacios) → null; texto → sin ningún espacio; entero no negativo → texto.
// Cualquier otro tipo → { ok: false }.
function normalizeCode(field, raw) {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      return { ok: false, message: `${LABELS[field]} debe ser un número entero no negativo.` };
    }
    return { ok: true, value: String(raw) };
  }
  if (typeof raw !== 'string') {
    return { ok: false, message: `${LABELS[field]} debe ser texto, un número o null.` };
  }
  const compact = raw.replace(/\s+/g, '');
  return { ok: true, value: compact === '' ? null : compact };
}

function parseExpectedUpdatedAt(raw) {
  if (typeof raw !== 'string' || !ISO_DATE.test(raw)) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Valida el cuerpo del PATCH. Devuelve { ok: true, set, expectedUpdatedAt } con set en nombres de
// la base ({ sapOwnerId?, sapOwnerId_2? }), o { ok: false, message }.
export function checkOwnerMappingPatch(body) {
  if (!isPlainObject(body)) {
    return { ok: false, message: 'El cuerpo debe ser un objeto JSON.' };
  }

  const unknown = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    const names = unknown.slice(0, 5).join(', ');
    return {
      ok: false,
      message: unknown.length === 1
        ? `El campo ${names} no se puede editar desde el panel.`
        : `Los campos ${names} no se pueden editar desde el panel.`,
    };
  }

  const present = Object.keys(EDITABLE_OWNER_FIELDS).filter((field) => Object.hasOwn(body, field));
  if (present.length === 0) {
    return { ok: false, message: 'Indica el código de vendedor o el código de empleado.' };
  }

  const set = {};
  for (const field of present) {
    const normalized = normalizeCode(field, body[field]);
    if (!normalized.ok) {
      return normalized;
    }
    if (normalized.value !== null && !RULES[field](normalized.value)) {
      return { ok: false, message: RULE_MESSAGES[field] };
    }
    set[EDITABLE_OWNER_FIELDS[field]] = normalized.value;
  }

  if (!Object.hasOwn(body, 'expectedUpdatedAt') || body.expectedUpdatedAt === null || body.expectedUpdatedAt === undefined) {
    return { ok: false, message: 'Falta expectedUpdatedAt: recarga la lista e intenta de nuevo.' };
  }
  const expectedUpdatedAt = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!expectedUpdatedAt) {
    return { ok: false, message: 'expectedUpdatedAt debe ser una fecha ISO válida.' };
  }

  return { ok: true, set, expectedUpdatedAt };
}

function asText(value) {
  return value === undefined || value === null ? null : String(value);
}

// Lo que cambia de verdad entre la fila actual y el set validado, con nombres genéricos:
// [{ field: 'erpOwnerId' | 'erpEmployeeId', from, to }]. Compara como texto (documentos viejos
// pueden tener número); null y ausente son lo mismo.
export function diffOwnerMapping(current, set) {
  const changes = [];
  for (const [field, column] of Object.entries(EDITABLE_OWNER_FIELDS)) {
    if (!Object.hasOwn(set, column)) {
      continue;
    }
    const from = asText(current?.[column]);
    const to = asText(set[column]);
    if (from !== to) {
      changes.push({ field, from, to });
    }
  }
  return changes;
}
