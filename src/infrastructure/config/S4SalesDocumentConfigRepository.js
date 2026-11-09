import { toNonEmptyString } from '#shared/utils/string.utils.js';

export const S4_SALES_DOCUMENT_CONFIG_KEY = 's4SalesDocument';
export const S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY = 's4BusinessPartnerCreation';

// findOne directo, sin el upsert-on-missing de tenantConfiguration.service.getValue: un
// tenant B1 que nunca va a usar estas llaves no tiene por qué recibir documentos vacíos.
async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function toStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => toNonEmptyString(entry)).filter(Boolean)
    : [];
}

function normalizeCreationDefaults(rawDefaults) {
  return {
    BusinessPartner: toPlainObject(rawDefaults.BusinessPartner),
    BusinessPartnerRole: toStringList(rawDefaults.BusinessPartnerRole),
    Customer: toPlainObject(rawDefaults.Customer),
    CustomerCompany: toPlainObject(rawDefaults.CustomerCompany),
    CustomerSalesArea: toPlainObject(rawDefaults.CustomerSalesArea),
  };
}

// Person partners (category 1) may override each sub-key of the company defaults. A sub-key
// that is absent from `personDefaults` falls back to the company value; one that is present
// (even empty) wins, so a tenant can drop e.g. the company-code data for persons.
function resolvePersonDefaults(rawPersonDefaults, companyDefaults) {
  const person = normalizeCreationDefaults(rawPersonDefaults);
  const resolved = {};

  for (const key of Object.keys(companyDefaults)) {
    resolved[key] = Object.hasOwn(rawPersonDefaults, key)
      ? person[key]
      : structuredClone(companyDefaults[key]);
  }

  return resolved;
}

export function buildS4SalesDocumentDefaults() {
  return {
    quotationType: null,
    salesOrganization: null,
    distributionChannel: null,
    division: null,
    salesPersonPartnerFunction: null,
    priceConditionType: null,
  };
}

export function buildS4BusinessPartnerCreationDefaults() {
  return {
    findFallbackField: null,
    defaults: {
      BusinessPartner: {},
      BusinessPartnerRole: [],
      Customer: {},
      CustomerCompany: {},
      CustomerSalesArea: {},
    },
    personDefaults: {
      BusinessPartner: {},
      BusinessPartnerRole: [],
      Customer: {},
      CustomerCompany: {},
      CustomerSalesArea: {},
    },
  };
}

export class S4SalesDocumentConfigRepository {
  async getSalesDocumentConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, S4_SALES_DOCUMENT_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildS4SalesDocumentDefaults();
      }

      return {
        quotationType: toNonEmptyString(raw.quotationType),
        salesOrganization: toNonEmptyString(raw.salesOrganization),
        distributionChannel: toNonEmptyString(raw.distributionChannel),
        division: toNonEmptyString(raw.division),
        salesPersonPartnerFunction: toNonEmptyString(raw.salesPersonPartnerFunction),
        priceConditionType: toNonEmptyString(raw.priceConditionType),
      };
    } catch (error) {
      console.error('s4SalesDocument config read error:', error);
      return buildS4SalesDocumentDefaults();
    }
  }

  async getBusinessPartnerCreationConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, S4_BUSINESS_PARTNER_CREATION_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildS4BusinessPartnerCreationDefaults();
      }

      const defaults = normalizeCreationDefaults(toPlainObject(raw.defaults));

      return {
        findFallbackField: toNonEmptyString(raw.findFallbackField),
        defaults,
        personDefaults: resolvePersonDefaults(toPlainObject(raw.personDefaults), defaults),
      };
    } catch (error) {
      console.error('s4BusinessPartnerCreation config read error:', error);
      return buildS4BusinessPartnerCreationDefaults();
    }
  }
}

export default S4SalesDocumentConfigRepository;
