// Flavor-agnostic customer entity produced by the SapCustomerPort adapters.
// Normalized fields serve cross-cutting logic (dedup key, email selection,
// person/organization split); `raw` carries the flavor-specific record so
// per-tenant FieldMappings keep operating on native SAP field names.

export const SAP_CUSTOMER_KINDS = Object.freeze({
  PERSON: 'person',
  ORGANIZATION: 'organization',
  GROUP: 'group',
  UNKNOWN: 'unknown',
});

function cleanString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

// Combines a date (ISO or YYYY-MM-DD) with an HH:mm:ss time into a single
// timezone-naive timestamp string. SAP stores both flavors' change times in
// the server's local time, so no zone is asserted here.
export function combineSapDateTime(date, time) {
  const dateValue = cleanString(date);
  if (!dateValue) {
    return null;
  }

  const datePart = dateValue.split('T')[0];
  const timePart = cleanString(time) || '00:00:00';
  return `${datePart}T${timePart}`;
}

function normalizeContactPoint(entry, valueKey) {
  const value = cleanString(entry?.[valueKey]);
  if (!value) {
    return null;
  }

  return {
    value,
    isDefault: entry?.isDefault === true,
  };
}

export function createSapCustomer({
  idSap,
  kind = SAP_CUSTOMER_KINDS.UNKNOWN,
  name = null,
  isCustomer = false,
  customerCode = null,
  priceListNum = null,
  emails = [],
  phones = [],
  updatedAt = null,
  raw = null,
} = {}) {
  const normalizedIdSap = cleanString(idSap);
  if (!normalizedIdSap) {
    throw new Error('idSap is required to build a SAP customer entity');
  }

  const normalizedKind = Object.values(SAP_CUSTOMER_KINDS).includes(kind)
    ? kind
    : SAP_CUSTOMER_KINDS.UNKNOWN;

  return {
    idSap: normalizedIdSap,
    kind: normalizedKind,
    name: cleanString(name),
    isCustomer: isCustomer === true,
    customerCode: cleanString(customerCode),
    priceListNum: Number.isFinite(Number(priceListNum)) && priceListNum !== null && priceListNum !== ''
      ? Number(priceListNum)
      : null,
    emails: (Array.isArray(emails) ? emails : [])
      .map((entry) => normalizeContactPoint(entry, 'value'))
      .filter(Boolean),
    phones: (Array.isArray(phones) ? phones : [])
      .map((entry) => normalizeContactPoint(entry, 'value'))
      .filter(Boolean),
    updatedAt: cleanString(updatedAt),
    raw: raw ?? null,
  };
}

export default {
  SAP_CUSTOMER_KINDS,
  combineSapDateTime,
  createSapCustomer,
};
