import { CAUSE_GROUPS, classifyError } from './errorCauses.js';
import { eventStatusToApi } from './operationViews.js';
import { eachLocalDay, localDate, toMs } from './period.js';

// Resumen de integración del Inicio (contrato 05, F2 a F6) a partir de los eventos crudos del
// período. Misma lógica que la API simulada del front, sobre los estados internos.

// F3, con los estados internos (E1).
const CREATED = new Set(['completed', 'sap_order_created', 'sap_created_hubspot_error']);
const ERRORED = new Set(['errored']);
const PENDING = new Set(['waiting', 'inprocess']);
const MAX_MULTI_ATTEMPT = 10;

export function documentGroup(status) {
  if (CREATED.has(status)) {
    return 'created';
  }
  if (ERRORED.has(status)) {
    return 'errored';
  }
  if (PENDING.has(status)) {
    return 'pending';
  }
  return null;
}

const durationSeconds = (doc) => (toMs(doc.updatedAt) - toMs(doc.createdAt)) / 1000;

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
}

function referenceOf(raw) {
  const value = raw.payload?.deal?.hs_object_id;
  return value === undefined || value === null || value === '' ? null : String(value);
}

function documentNumberOf(raw) {
  const value = raw.sapAudit?.responseSap?.DocNum;
  return value === undefined || value === null || value === '' ? null : String(value);
}

// Más frecuentes primero; en el empate, "other" al final y luego por etiqueta.
function byCountDesc(left, right) {
  return right.count - left.count
    || Number(left.key === 'other') - Number(right.key === 'other')
    || String(left.label).localeCompare(String(right.label), 'es');
}

function summarizeCauses(errored) {
  const causes = new Map();
  for (const doc of errored) {
    const cause = classifyError(doc.lastError);
    const entry = causes.get(cause.key) ?? { ...cause, count: 0 };
    entry.count += 1;
    causes.set(cause.key, entry);
  }
  const groups = new Map();
  for (const cause of causes.values()) {
    groups.set(cause.group, (groups.get(cause.group) ?? 0) + cause.count);
  }
  return {
    causes: [...causes.values()].sort(byCountDesc),
    groups: [...groups]
      .map(([key, count]) => ({ key, count }))
      .sort((left, right) => right.count - left.count || CAUSE_GROUPS.indexOf(left.key) - CAUSE_GROUPS.indexOf(right.key)),
  };
}

function step(doc) {
  let summary = 'En proceso';
  if (doc.group === 'errored') {
    summary = classifyError(doc.lastError).label;
  } else if (doc.group === 'created') {
    summary = 'Documento creado';
  }
  return {
    at: new Date(doc.createdMs).toISOString(),
    status: eventStatusToApi(doc.status),
    summary,
    documentNumber: doc.group === 'created' ? doc.documentNumber : null,
  };
}

function summarizeAttempts(docs) {
  const byReference = new Map();
  for (const doc of docs) {
    if (doc.reference) {
      if (!byReference.has(doc.reference)) {
        byReference.set(doc.reference, []);
      }
      byReference.get(doc.reference).push(doc);
    }
  }
  const repeated = [...byReference.values()]
    .filter((attempts) => attempts.length > 1)
    .map((attempts) => [...attempts].sort((left, right) => left.createdMs - right.createdMs))
    .sort((left, right) => right.length - left.length || right.at(-1).createdMs - left.at(-1).createdMs);

  return {
    total: repeated.length,
    items: repeated.slice(0, MAX_MULTI_ATTEMPT).map((attempts) => {
      const created = attempts.find((doc) => doc.group === 'created');
      return {
        reference: attempts[0].reference,
        title: attempts.find((doc) => doc.title)?.title ?? null,
        attempts: attempts.length,
        resolvedAfterSeconds: created ? Math.round((created.updatedMs - attempts[0].createdMs) / 1000) : null,
        steps: attempts.map(step),
      };
    }),
  };
}

// rawEvents: eventos del tenant con createdAt en [from, to). period: { from, to, tz } en ms.
// onUnknownStatus(status): aviso para estados sin traducción (quedan fuera de los totales).
export function integrationSummary(rawEvents, { from, to, tz }, { onUnknownStatus } = {}) {
  const docs = [];
  for (const raw of rawEvents) {
    const createdMs = toMs(raw.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < from || createdMs >= to) {
      continue;
    }
    const group = documentGroup(raw.status);
    if (!group) {
      if (raw.status !== 'report') {
        onUnknownStatus?.(raw.status);
      }
      continue;
    }
    docs.push({
      group,
      status: raw.status,
      lastError: raw.lastError ?? null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      createdMs,
      updatedMs: toMs(raw.updatedAt),
      reference: referenceOf(raw),
      title: raw.payload?.deal?.dealname ?? null,
      documentNumber: documentNumberOf(raw),
    });
  }

  const inGroup = (group) => docs.filter((doc) => doc.group === group);
  const created = inGroup('created');
  const errored = inGroup('errored');
  const pending = inGroup('pending');

  const references = new Set(docs.map((doc) => doc.reference).filter(Boolean));
  const withDocument = new Set(created.map((doc) => doc.reference).filter(Boolean));

  const days = new Map(eachLocalDay(from, to, tz).map((date) => [date, { date, created: 0, errored: 0, pending: 0 }]));
  for (const doc of docs) {
    const day = days.get(localDate(doc.createdMs, tz));
    if (day) {
      day[doc.group] += 1;
    }
  }

  const oldestPending = pending.reduce((oldest, doc) => (oldest === null || doc.createdMs < oldest ? doc.createdMs : oldest), null);

  return {
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), tz },
    totals: {
      documents: docs.length,
      created: created.length,
      errored: errored.length,
      pending: pending.length,
      references: references.size,
      referencesWithoutDocument: [...references].filter((reference) => !withDocument.has(reference)).length,
      avgDurationSeconds: average([...created, ...errored].map(durationSeconds)),
      avgDurationCreatedSeconds: average(created.map(durationSeconds)),
      oldestPendingAt: oldestPending === null ? null : new Date(oldestPending).toISOString(),
    },
    byDay: [...days.values()],
    ...summarizeCauses(errored),
    multiAttempt: summarizeAttempts(docs),
  };
}
