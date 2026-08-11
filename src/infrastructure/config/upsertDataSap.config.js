export const UPSERT_DATA_SAP_CONFIG_KEY = 'upsertDataSAP';

export const DEFAULT_UPSERT_DATA_SAP_CONFIG = {
  required: false,
  fieldsUpdated_BP: [],
  fieldsUpdated_CE: [],
};

// Field names are SAP fields sent straight through in a PATCH ('CardName',
// 'EmailAddress', 'U_MyField'...). Dotted paths (S/4 nav-property style) are
// rejected here: they would break the $select this config drives, and this
// feature is B1-only for now.
const VALID_SAP_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeFieldList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  value.forEach((entry) => {
    const field = String(entry ?? '').trim();

    if (!field || !VALID_SAP_FIELD_NAME.test(field) || seen.has(field)) {
      return;
    }

    seen.add(field);
    normalized.push(field);
  });

  return normalized;
}

function normalizeUpsertDataSapConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_UPSERT_DATA_SAP_CONFIG };
  }

  const required = value.required === true || value.required === 'true';
  const fieldsUpdated_BP = normalizeFieldList(value.fieldsUpdated_BP);
  const fieldsUpdated_CE = normalizeFieldList(value.fieldsUpdated_CE);

  return { required, fieldsUpdated_BP, fieldsUpdated_CE };
}

/**
 * Reads the tenant `upsertDataSAP` configuration used by the deal webhook flow
 * (createDeal / createQuotation / inventoryTransferRequest) to decide whether
 * an already-existing BusinessPartner/ContactEmployee should be updated with
 * the data currently in HubSpot, and which SAP fields are eligible.
 */
export async function getUpsertDataSapConfig({ tenantContext, tenantModels } = {}) {
  const Configuration = (tenantContext?.tenantModels ?? tenantModels)?.Configuration;

  if (typeof Configuration?.findOne !== 'function') {
    return { ...DEFAULT_UPSERT_DATA_SAP_CONFIG };
  }

  const query = Configuration.findOne({ key: UPSERT_DATA_SAP_CONFIG_KEY });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return normalizeUpsertDataSapConfig(configuration?.value);
}

export default { getUpsertDataSapConfig, UPSERT_DATA_SAP_CONFIG_KEY, DEFAULT_UPSERT_DATA_SAP_CONFIG };
