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

      const rawDefaults = toPlainObject(raw.defaults);

      return {
        findFallbackField: toNonEmptyString(raw.findFallbackField),
        defaults: {
          BusinessPartner: toPlainObject(rawDefaults.BusinessPartner),
          BusinessPartnerRole: toStringList(rawDefaults.BusinessPartnerRole),
          Customer: toPlainObject(rawDefaults.Customer),
          CustomerCompany: toPlainObject(rawDefaults.CustomerCompany),
          CustomerSalesArea: toPlainObject(rawDefaults.CustomerSalesArea),
        },
      };
    } catch (error) {
      console.error('s4BusinessPartnerCreation config read error:', error);
      return buildS4BusinessPartnerCreationDefaults();
    }
  }
}

export default S4SalesDocumentConfigRepository;
