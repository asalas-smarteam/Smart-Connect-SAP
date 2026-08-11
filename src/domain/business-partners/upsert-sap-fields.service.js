// Pure diff logic for the upsertDataSAP config: given the SAP fields a tenant
// wants kept in sync from HubSpot, decide which ones actually changed so the
// caller only PATCHes what's needed. No SAP/HubSpot infra dependency here on
// purpose - see docs/superpowers/specs/2026-08-10-upsert-data-sap-design.md.

// ContactEmployee has no EmailAddress property in SAP B1 (only BusinessPartner
// does) - SapWebhookOrderAdapter's resolveContactEmployeePayload already
// writes the mapped email onto E_Mail. A tenant configuring fieldsUpdated_CE
// with 'EmailAddress' means the same thing.
const CONTACT_EMPLOYEE_FIELD_ALIASES = {
  EmailAddress: 'E_Mail',
};

function isBlank(value) {
  return value === null || typeof value === 'undefined' || String(value).trim() === '';
}

function isNumeric(value) {
  return typeof value !== 'boolean' && value !== '' && value !== null && Number.isFinite(Number(value));
}

/**
 * true when the HubSpot value should overwrite the current SAP value.
 * A blank/missing HubSpot value never counts as a difference (we never blank
 * out SAP data because of an incomplete webhook payload).
 */
export function valuesDiffer(hubspotValue, sapValue) {
  if (isBlank(hubspotValue)) {
    return false;
  }

  if (isNumeric(hubspotValue) && isNumeric(sapValue)) {
    return Number(hubspotValue) !== Number(sapValue);
  }

  const normalizedHubspotValue = String(hubspotValue).trim();
  const normalizedSapValue = isBlank(sapValue) ? '' : String(sapValue).trim();

  return normalizedHubspotValue !== normalizedSapValue;
}

function resolveHubspotFieldValue(field, mappedCompany, mappedContact) {
  const companyValue = mappedCompany?.[field];
  return isBlank(companyValue) ? mappedContact?.[field] : companyValue;
}

export function buildBusinessPartnerUpdatePayload({
  fields,
  mappedCompany,
  mappedContact,
  sapBusinessPartner,
}) {
  const payload = {};

  (Array.isArray(fields) ? fields : []).forEach((field) => {
    const hubspotValue = resolveHubspotFieldValue(field, mappedCompany, mappedContact);

    if (isBlank(hubspotValue)) {
      return;
    }

    if (valuesDiffer(hubspotValue, sapBusinessPartner?.[field])) {
      payload[field] = typeof hubspotValue === 'string' ? hubspotValue.trim() : hubspotValue;
    }
  });

  return payload;
}

export function buildContactEmployeeUpdatePayload({ fields, nextEmployee, existingEmployee }) {
  const payload = {};

  (Array.isArray(fields) ? fields : []).forEach((field) => {
    const sapField = CONTACT_EMPLOYEE_FIELD_ALIASES[field] || field;
    const hubspotValue = nextEmployee?.[sapField];

    if (isBlank(hubspotValue)) {
      return;
    }

    if (valuesDiffer(hubspotValue, existingEmployee?.[sapField])) {
      payload[sapField] = typeof hubspotValue === 'string' ? hubspotValue.trim() : hubspotValue;
    }
  });

  return payload;
}

export default {
  valuesDiffer,
  buildBusinessPartnerUpdatePayload,
  buildContactEmployeeUpdatePayload,
};
