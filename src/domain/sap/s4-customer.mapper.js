import {
  SAP_CUSTOMER_KINDS,
  combineSapDateTime,
  createSapCustomer,
} from './sap-customer.entity.js';

const CATEGORY_TO_KIND = Object.freeze({
  1: SAP_CUSTOMER_KINDS.PERSON,
  2: SAP_CUSTOMER_KINDS.ORGANIZATION,
  3: SAP_CUSTOMER_KINDS.GROUP,
});

function cleanString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Collects contact points across every address, deduplicating by value.
// A value flagged default anywhere stays default; no selection rule is
// applied here — which entry wins is a business decision made upstream.
function collectContactPoints(addresses, navigationKeys, valueFields, defaultField) {
  const byValue = new Map();

  for (const address of asArray(addresses)) {
    for (const navigationKey of navigationKeys) {
      for (const entry of asArray(address?.[navigationKey])) {
        const value = valueFields
          .map((field) => cleanString(entry?.[field]))
          .find(Boolean);

        if (!value) {
          continue;
        }

        const isDefault = entry?.[defaultField] === true;
        const existing = byValue.get(value);
        if (!existing) {
          byValue.set(value, { value, isDefault });
        } else if (isDefault && !existing.isDefault) {
          existing.isDefault = true;
        }
      }
    }
  }

  return [...byValue.values()];
}

function resolveName(record, kind) {
  if (kind === SAP_CUSTOMER_KINDS.ORGANIZATION) {
    return (
      cleanString(record.OrganizationBPName1)
      || cleanString(record.BusinessPartnerFullName)
      || cleanString(record.BusinessPartnerName)
    );
  }

  const composedPersonName = [cleanString(record.FirstName), cleanString(record.LastName)]
    .filter(Boolean)
    .join(' ');

  return (
    cleanString(record.BusinessPartnerFullName)
    || cleanString(composedPersonName)
    || cleanString(record.BusinessPartnerName)
  );
}

// Maps a (transport-normalized) A_BusinessPartner record to the common
// customer entity. Expects expanded to_BusinessPartnerAddress with
// to_EmailAddress / to_PhoneNumber when contact data is needed.
export function mapS4BusinessPartnerToCustomer(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const kind = CATEGORY_TO_KIND[cleanString(record.BusinessPartnerCategory)]
    || SAP_CUSTOMER_KINDS.UNKNOWN;
  const addresses = record.to_BusinessPartnerAddress;
  const customerCode = cleanString(record.Customer);

  return createSapCustomer({
    idSap: record.BusinessPartner,
    kind,
    name: resolveName(record, kind),
    isCustomer: Boolean(customerCode),
    customerCode,
    // S/4 has no price list entity; the closest concept (condition-based
    // pricing) is a pending business definition. Kept null on purpose.
    priceListNum: null,
    emails: collectContactPoints(
      addresses,
      ['to_EmailAddress'],
      ['EmailAddress'],
      'IsDefaultEmailAddress'
    ),
    phones: collectContactPoints(
      addresses,
      ['to_PhoneNumber', 'to_MobilePhoneNumber'],
      ['PhoneNumber', 'InternationalPhoneNumber'],
      'IsDefaultPhoneNumber'
    ),
    updatedAt: combineSapDateTime(record.LastChangeDate, record.LastChangeTime),
    raw: record,
  });
}

export default mapS4BusinessPartnerToCustomer;
