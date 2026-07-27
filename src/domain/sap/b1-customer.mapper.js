import {
  SAP_CUSTOMER_KINDS,
  combineSapDateTime,
  createSapCustomer,
} from './sap-customer.entity.js';

// Depending on the Service Layer version/config, B1 enums arrive either as
// single characters ('C'/'I') or as SDK names ('cCompany'/'cPrivate').
const COMPANY_PRIVATE_TO_KIND = Object.freeze({
  C: SAP_CUSTOMER_KINDS.ORGANIZATION,
  cCompany: SAP_CUSTOMER_KINDS.ORGANIZATION,
  I: SAP_CUSTOMER_KINDS.PERSON,
  cPrivate: SAP_CUSTOMER_KINDS.PERSON,
});

const CUSTOMER_CARD_TYPES = new Set(['C', 'cCustomer']);

function cleanString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function mapB1BusinessPartnerToCustomer(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const emails = [];
  const email = cleanString(record.EmailAddress);
  if (email) {
    emails.push({ value: email, isDefault: true });
  }

  const phones = [];
  const phone1 = cleanString(record.Phone1);
  if (phone1) {
    phones.push({ value: phone1, isDefault: true });
  }
  const phone2 = cleanString(record.Phone2);
  if (phone2) {
    phones.push({ value: phone2, isDefault: false });
  }

  return createSapCustomer({
    idSap: record.CardCode,
    kind: COMPANY_PRIVATE_TO_KIND[cleanString(record.CompanyPrivate)]
      || SAP_CUSTOMER_KINDS.UNKNOWN,
    name: record.CardName,
    isCustomer: CUSTOMER_CARD_TYPES.has(cleanString(record.CardType)),
    customerCode: record.CardCode,
    priceListNum: record.PriceListNum ?? null,
    emails,
    phones,
    updatedAt: combineSapDateTime(record.UpdateDate, record.UpdateTime),
    raw: record,
  });
}

export default mapB1BusinessPartnerToCustomer;
