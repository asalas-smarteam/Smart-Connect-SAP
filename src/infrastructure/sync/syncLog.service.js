import { resolveErrorMessageText } from '#application/services/error-message.service.js';

export function serializeLogValue(value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  try {
    return JSON.parse(
      JSON.stringify(value, (_key, currentValue) => {
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
          };
        }

        if (typeof currentValue === 'undefined') {
          return null;
        }

        return currentValue;
      })
    );
  } catch (_error) {
    return String(value);
  }
}

export function buildErrorResponseSnapshot(error) {
  if (!error) {
    return null;
  }

  return serializeLogValue({
    name: error.name || 'Error',
    message: error.message || 'Unknown error',
    status: error?.response?.status ?? error?.details?.status ?? null,
    statusText: error?.response?.statusText ?? error?.details?.statusText ?? null,
    details: error?.details || null,
    response: error?.response?.data ?? null,
  });
}

export function buildWebhookSyncErrorEntry({
  payloadHubspot = null,
  payloadSap = null,
  responseHubspot = null,
  responseSap = null,
} = {}) {
  return {
    payload_Hubspot: serializeLogValue(payloadHubspot),
    payload_SAP: serializeLogValue(payloadSap),
    response_hubspot: serializeLogValue(responseHubspot),
    response_SAP: serializeLogValue(responseSap),
  };
}

function isEmptyAuditValue(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isEmptyAuditValue);
  }

  if (typeof value === 'object') {
    return Object.values(value).every(isEmptyAuditValue);
  }

  return false;
}

// El audit guarda cuerpos arbitrarios de SAP, así que ninguna clave puede darse por buena:
// MongoDB rechaza el `$set` COMPLETO si encuentra una clave con `$` al inicio, y con él se
// pierden también el `status` y el `lastError` del evento. Pasó en producción con los params
// de OData: "The dollar ($) prefixed field '$select' in 'sapAudit.sapCalls.0.params.$select'
// is not valid for storage".
//
// - `@odata.*` (`@odata.context`, `@odata.etag`, `DocumentLines@odata.count`): se descartan,
//   son ruido puro en una auditoría.
// - `$` inicial: se prefija con `_` (`$select` -> `_$select`). El nombre real sigue legible.
// - `.` en el nombre: se reemplaza por `_`. Mongo solo las admite desde la 5.0 y no vale
//   arriesgar la escritura por un nombre de clave.
function sanitizeAuditKey(key) {
  const withoutDots = key.replace(/\./g, '_');
  return withoutDots.startsWith('$') ? `_${withoutDots}` : withoutDots;
}

// Operates on the already-serialized (JSON-safe, non-circular) output of serializeLogValue,
// never on the raw SAP response.
function sanitizeAuditKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeAuditKeys);
  }

  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.includes('@odata.')) {
        continue;
      }
      cleaned[sanitizeAuditKey(key)] = sanitizeAuditKeys(nested);
    }
    return cleaned;
  }

  return value;
}

function serializeAuditObject(obj) {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return sanitizeAuditKeys(serializeLogValue(obj));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[sanitizeAuditKey(key)] = sanitizeAuditKeys(serializeLogValue(value));
  }
  return result;
}

// Tope por cuerpo serializado. El documento del WebhookEvent tiene que poder guardarse
// SIEMPRE: si el $set se pasa del límite de Mongo, no se pierde solo la auditoría, se pierde
// también el `lastError` que va en la misma escritura.
const MAX_AUDIT_BODY_CHARS = 20000;

function truncateAuditBody(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return value;
  }

  if (!serialized || serialized.length <= MAX_AUDIT_BODY_CHARS) {
    return value;
  }

  return {
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, MAX_AUDIT_BODY_CHARS),
  };
}

// Los params de OData se guardan como query string, no como objeto: sus claves (`$top`,
// `$select`, `$filter`) son justo las que hacen que Mongo rechace la escritura, y en una sola
// línea se leen mejor que anidadas.
function serializeAuditParams(params) {
  if (params === null || params === undefined) {
    return null;
  }

  if (typeof params !== 'object' || Array.isArray(params)) {
    return String(params);
  }

  return Object.entries(params)
    .map(([key, value]) => `${key}=${value === null || value === undefined ? '' : String(value)}`)
    .join('&');
}

// Cada entrada viene del grabador de transporte (infrastructure/sap/sapCallRecorder.js) con
// el error de SAP crudo; acá se convierte al mismo snapshot que ya usa el SyncLog.
function serializeSapCalls(sapCalls) {
  if (!Array.isArray(sapCalls)) {
    return [];
  }

  return sapCalls.map((call) => {
    const serialized = {
      method: call?.method ?? null,
      path: call?.path ?? null,
      params: serializeAuditParams(call?.params),
      request: truncateAuditBody(sanitizeAuditKeys(serializeLogValue(call?.request ?? null))),
      ok: call?.ok !== false,
      status: call?.status ?? null,
      durationMs: call?.durationMs ?? null,
    };

    if (call?.ok === false) {
      // `message` se sobreescribe con el texto resuelto de SAP: el de axios es siempre
      // "Request failed with status code 400" y el motivo real viaja en
      // `data.error.message.value`. Así queda igual al `lastError` del WebhookEvent.
      serialized.error = sanitizeAuditKeys({
        ...buildErrorResponseSnapshot(call?.error),
        message: resolveErrorMessageText(call?.error),
      });
      return serialized;
    }

    serialized.response = truncateAuditBody(sanitizeAuditKeys(serializeLogValue(call?.response ?? null)));
    return serialized;
  });
}

// Builds the persisted record of everything a webhook use case sent to and received from
// SAP (BusinessPartner, ContactEmployee, order/quotation), plus the HubSpot response, so a
// failed WebhookEvent shows exactly what was attempted instead of just an error message.
// `sapCalls` is the raw traffic log and is the only part that survives a SAP call that
// throws: the payload_SAP/response_SAP keys are filled from the adapters' return values, so
// they stay null for the call that failed.
// Returns null when nothing was ever sent to SAP (e.g. the use case failed before its first
// SAP call), so WebhookEvent documents aren't cluttered with an all-null audit record.
export function buildWebhookSapAudit(auditTrail) {
  try {
    const payloadSap = serializeAuditObject(auditTrail?.payload_SAP ?? null);
    const responseSap = serializeAuditObject(auditTrail?.response_SAP ?? null);
    const responseHubspot = sanitizeAuditKeys(serializeLogValue(auditTrail?.response_hubspot ?? null));
    const responseHubspotContactEmployees = sanitizeAuditKeys(serializeLogValue(
      auditTrail?.response_hubspot_contactEmployees ?? null
    ));
    const sapCalls = serializeSapCalls(auditTrail?.sapCalls);
    // Un evento saltado por idempotencia no habla con SAP, así que sin esto guardaba
    // `sapAudit: null`, que se lee igual que "la auditoría está rota" -- exactamente la
    // confusión que hubo con 13 eventos completados cuyas cotizaciones ya existían.
    const skipped = sanitizeAuditKeys(serializeLogValue(auditTrail?.skipped ?? null));

    if (
      sapCalls.length === 0
      && isEmptyAuditValue(skipped)
      && isEmptyAuditValue(payloadSap)
      && isEmptyAuditValue(responseSap)
      && isEmptyAuditValue(responseHubspot)
    ) {
      return null;
    }

    return {
      payloadSap,
      responseSap,
      sapCalls,
      skipped,
      responseHubspot,
      responseHubspotContactEmployees,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

const SYNC_LOG_OBJECT_TYPES = Object.freeze({
  product: 'Product',
  products: 'Product',
  contact: 'Contact',
  contacts: 'Contact',
  deal: 'Deal',
  deals: 'Deal',
  company: 'Company',
  companies: 'Company',
  invoice: 'Invoice',
  invoices: 'Invoice',
});

export function normalizeSyncLogObjectType(objectType) {
  const normalized = String(objectType || '').trim().toLowerCase();
  return SYNC_LOG_OBJECT_TYPES[normalized] || null;
}

export async function startSyncLog({
  tenantModels,
  clientConfigId = null,
  objectType = null,
  startedAt = new Date(),
} = {}) {
  const SyncLog = tenantModels?.SyncLog;

  if (!SyncLog) {
    return null;
  }

  return SyncLog.create({
    clientConfigId: clientConfigId || undefined,
    objectType: normalizeSyncLogObjectType(objectType),
    recordsProcessed: 0,
    sent: 0,
    failed: 0,
    errorMessage: null,
    startedAt,
    finishedAt: null,
  });
}

export async function finishSyncLog(syncLog, {
  status,
  recordsProcessed = 0,
  sent = 0,
  failed = 0,
  errorMessage = null,
  errors = [],
  finishedAt = new Date(),
} = {}) {
  if (!syncLog?.constructor?.updateOne || !syncLog?._id) {
    return null;
  }

  const nextValues = {
    recordsProcessed: Number.isFinite(Number(recordsProcessed))
      ? Number(recordsProcessed)
      : 0,
    sent: Number.isFinite(Number(sent))
      ? Number(sent)
      : 0,
    failed: Number.isFinite(Number(failed))
      ? Number(failed)
      : 0,
    errorMessage: errorMessage ?? null,
    errors: Array.isArray(errors) ? serializeLogValue(errors) ?? [] : [],
    finishedAt,
  };

  nextValues.status = status;

  await syncLog.constructor.updateOne({ _id: syncLog._id }, { $set: nextValues });

  return {
    _id: syncLog._id,
    ...nextValues,
  };
}
