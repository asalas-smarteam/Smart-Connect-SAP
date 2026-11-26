import { toNonEmptyString } from '#shared/utils/string.utils.js';

export const CONSUMER_FINAL_NIT_CONFIG_KEY = 'consumerFinalNit';

const DEFAULT_CONFIG = Object.freeze({ enabled: false, identityProperty: null });

function normalizeTaxIdText(value) {
  const text = toNonEmptyString(value);
  return text ? text.toUpperCase().replace(/[.\-\s]/g, '') : '';
}

// Cleans a configured placeholder list: keeps only non-empty strings, normalized
// like the tax ids they are compared with. Anything else yields [].
export function normalizeConsumerFinalPlaceholders(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === 'string')
    .map(normalizeTaxIdText)
    .filter(Boolean);
}

// With tenant placeholders, the normalized tax id must equal one of them exactly.
// Without usable placeholders it falls back to the generic pattern: "00000000C.F.",
// "c.f.", "C.F", "0000-0000 c-f" ... i.e. only zeros followed by CF, or CF alone.
export function isConsumerFinalNit(value, placeholders = null) {
  const normalized = normalizeTaxIdText(value);
  if (!normalized) {
    return false;
  }

  const custom = normalizeConsumerFinalPlaceholders(placeholders);
  return custom.length > 0 ? custom.includes(normalized) : /^0*CF$/.test(normalized);
}

// Opt-in per tenant: a missing/malformed key or enabled !== true keeps the
// legacy behavior. placeholders is optional (empty = generic pattern). identityProperty is the deal property holding the person's
// national id.
export function normalizeConsumerFinalNitConfig(value) {
  if (!value || typeof value !== 'object' || value.enabled !== true) {
    return { ...DEFAULT_CONFIG };
  }

  const identityProperty = toNonEmptyString(value.identityProperty);
  return identityProperty
    ? {
      enabled: true,
      identityProperty,
      placeholders: normalizeConsumerFinalPlaceholders(value.placeholders),
    }
    : { ...DEFAULT_CONFIG };
}

// Returns the national id to use in place of the consumer-final placeholder, or
// null when the tenant did not opt in or the deal carries no value. The value is
// only trimmed at the edges: the integration transports it as received.
export function resolveConsumerFinalIdentity({ config, deal }) {
  if (!config?.enabled || !config.identityProperty) {
    return null;
  }

  return toNonEmptyString(deal?.[config.identityProperty]);
}
