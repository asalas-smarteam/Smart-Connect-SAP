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

// SAP B1 Service Layer responses can carry OData annotation keys (e.g. `@odata.context`,
// `@odata.etag`, `DocumentLines@odata.count`) at any depth. MongoDB only allows dotted field
// names from server version 5.0 onward, and these annotations are pure noise in an audit
// record anyway, so they're stripped before persisting. Operates on the already-serialized
// (JSON-safe, non-circular) output of serializeLogValue, never on the raw SAP response.
function stripODataKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stripODataKeys);
  }

  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.includes('@odata.')) {
        continue;
      }
      cleaned[key] = stripODataKeys(nested);
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
    return stripODataKeys(serializeLogValue(obj));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = stripODataKeys(serializeLogValue(value));
  }
  return result;
}

// Builds the persisted record of everything a webhook use case sent to and received from
// SAP (BusinessPartner, ContactEmployee, order/quotation), plus the HubSpot response, so a
// failed WebhookEvent shows exactly what was attempted instead of just an error message.
// Returns null when nothing was ever sent to SAP (e.g. the use case failed before its first
// SAP call), so WebhookEvent documents aren't cluttered with an all-null audit record.
export function buildWebhookSapAudit(auditTrail) {
  try {
    const payloadSap = serializeAuditObject(auditTrail?.payload_SAP ?? null);
    const responseSap = serializeAuditObject(auditTrail?.response_SAP ?? null);
    const responseHubspot = serializeLogValue(auditTrail?.response_hubspot ?? null);

    if (isEmptyAuditValue(payloadSap) && isEmptyAuditValue(responseSap) && isEmptyAuditValue(responseHubspot)) {
      return null;
    }

    return {
      payloadSap,
      responseSap,
      responseHubspot,
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
