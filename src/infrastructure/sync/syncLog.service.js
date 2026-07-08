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
