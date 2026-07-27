// SAP flavor identifies which SAP product family a tenant connects to.
// B1 = SAP Business One (Service Layer, /b1s/v2, session-cookie auth).
// S4 = SAP S/4HANA (Gateway OData v2, /sap/opu/odata, basic auth).
export const SAP_FLAVORS = Object.freeze({
  B1: 'B1',
  S4: 'S4',
});

export const DEFAULT_SAP_FLAVOR = SAP_FLAVORS.B1;

const VALID_FLAVORS = new Set(Object.values(SAP_FLAVORS));

export function isValidSapFlavor(value) {
  return VALID_FLAVORS.has(String(value || '').trim().toUpperCase());
}

// Returns the canonical flavor for a raw input, or null when the input is
// present but invalid. Absent/empty input resolves to the default (B1) so
// existing callers and tenants keep their current behavior.
export function normalizeSapFlavor(value) {
  const raw = String(value ?? '').trim().toUpperCase();

  if (!raw) {
    return DEFAULT_SAP_FLAVOR;
  }

  return VALID_FLAVORS.has(raw) ? raw : null;
}

export default {
  SAP_FLAVORS,
  DEFAULT_SAP_FLAVOR,
  isValidSapFlavor,
  normalizeSapFlavor,
};
