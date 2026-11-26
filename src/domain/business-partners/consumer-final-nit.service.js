import { toNonEmptyString } from '#shared/utils/string.utils.js';

export const CONSUMER_FINAL_NIT_CONFIG_KEY = 'consumerFinalNit';

const DEFAULT_CONFIG = Object.freeze({ enabled: false, identityProperty: null });

// "00000000C.F.", "c.f.", "C.F", "0000-0000 c-f" ... all denote the generic
// consumer-final placeholder: only zeros followed by CF, or CF alone.
export function isConsumerFinalNit(value) {
  const text = toNonEmptyString(value);
  if (!text) {
    return false;
  }

  const normalized = text.toUpperCase().replace(/[.\-\s]/g, '');
  return /^0*CF$/.test(normalized);
}

// Opt-in per tenant: a missing/malformed key or enabled !== true keeps the
// legacy behavior. identityProperty is the deal property holding the person's
// national id.
export function normalizeConsumerFinalNitConfig(value) {
  if (!value || typeof value !== 'object' || value.enabled !== true) {
    return { ...DEFAULT_CONFIG };
  }

  const identityProperty = toNonEmptyString(value.identityProperty);
  return identityProperty
    ? { enabled: true, identityProperty }
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
