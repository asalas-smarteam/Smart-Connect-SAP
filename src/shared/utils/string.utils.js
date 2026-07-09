export function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeNumber(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

export function normalizePositiveInteger(value, fallback = null) {
  const normalized = Number(String(value ?? '').trim());
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

export function normalizeInteger(value, fallback = null) {
  if (value === null || typeof value === 'undefined' || String(value).trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function escapeODataString(value) {
  return String(value || '').replace(/'/g, "''");
}

