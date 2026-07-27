// Normalizes SAP Gateway OData v2 payloads (S/4HANA) into the plain JSON
// shape the rest of the pipeline already consumes from B1 Service Layer:
//  - envelope { d: { results: [...] } } / { d: {...} } is unwrapped
//  - Edm.DateTime  "/Date(1659571200000)/"       -> ISO-8601 string
//  - Edm.DateTimeOffset "/Date(1659571200000+0000)/" -> ISO-8601 string
//  - Edm.Time      "PT20H40M35S"                 -> "20:40:35"
//  - __metadata blocks are stripped
//  - deferred navigation props ({ __deferred }) are dropped
//  - expanded navigation props ({ results: [...] }) are flattened to arrays

const ODATA_DATE_PATTERN = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;
const ODATA_TIME_PATTERN = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function normalizeODataV2Scalar(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const dateMatch = ODATA_DATE_PATTERN.exec(value);
  if (dateMatch) {
    // The epoch milliseconds are already UTC; a trailing +/-HHMM in
    // Edm.DateTimeOffset is a display hint and does not shift the instant.
    return new Date(Number(dateMatch[1])).toISOString();
  }

  if (value.length > 2 && value.startsWith('PT')) {
    const timeMatch = ODATA_TIME_PATTERN.exec(value);
    if (timeMatch) {
      const [, hours = '0', minutes = '0', seconds = '0'] = timeMatch;
      return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    }
  }

  return value;
}

function isDeferredNavigation(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.__deferred
  );
}

function isExpandedCollection(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray(value.results)
  );
}

export function normalizeODataV2Value(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeODataV2Value(entry));
  }

  if (value && typeof value === 'object') {
    if (isExpandedCollection(value)) {
      return normalizeODataV2Value(value.results);
    }

    const normalized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__metadata' || isDeferredNavigation(entry)) {
        continue;
      }
      normalized[key] = normalizeODataV2Value(entry);
    }
    return normalized;
  }

  return normalizeODataV2Scalar(value);
}

// Unwraps { d: { results: [...] } } (collections) or { d: {...} } (single
// entities). Payloads without the v2 envelope pass through untouched.
export function unwrapODataV2Envelope(data) {
  if (data && typeof data === 'object' && 'd' in data) {
    const inner = data.d;
    if (isExpandedCollection(inner)) {
      return inner.results;
    }
    return inner;
  }

  return data;
}

export function extractODataV2NextLink(data) {
  const next = data?.d?.__next;
  return typeof next === 'string' && next.trim() ? next : null;
}

export function normalizeODataV2Response(data) {
  return normalizeODataV2Value(unwrapODataV2Envelope(data));
}

export default {
  normalizeODataV2Scalar,
  normalizeODataV2Value,
  unwrapODataV2Envelope,
  extractODataV2NextLink,
  normalizeODataV2Response,
};
