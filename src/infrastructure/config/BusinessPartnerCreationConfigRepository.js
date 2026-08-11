import {
  BUSINESS_PARTNER_CREATION_CONFIG_KEY,
  PROPERTIES_FLAGS_CONFIG_KEY,
  BP_PAYLOAD_STRATEGIES,
  DEFAULT_BP_PAYLOAD_STRATEGY,
  CONTACT_EMPLOYEE_SOURCES,
  DEFAULT_CONTACT_EMPLOYEE_SOURCE,
  BP_ADDRESS_STRATEGIES,
  DEFAULT_BP_ADDRESS_STRATEGY,
  PROPERTIES_FLAGS_STRATEGIES,
  DEFAULT_PROPERTIES_FLAGS_STRATEGY,
  DEFAULT_PROPERTIES_MIN,
  DEFAULT_PROPERTIES_MAX,
  DEFAULT_PROPERTIES_TRUE_VALUE,
} from '#domain/business-partners/business-partner-creation.constants.js';
import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { resolveSapFlavor } from '#infrastructure/config/SapFlavorConfigRepository.js';
import { normalizeInteger, toNonEmptyString } from '#shared/utils/string.utils.js';

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

function pickAllowed(value, allowedValues, fallback) {
  const normalized = String(value ?? '').trim();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

// Las llaves de byName y los valores de required se comparan contra el
// AddressName que llega del workflow de HubSpot, así que se normalizan igual
// en los tres lados: trim + minúsculas.
function normalizeAddressName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeByName(rawByName) {
  const byName = {};

  for (const [rawKey, rawValue] of Object.entries(toPlainObject(rawByName))) {
    const key = normalizeAddressName(rawKey);
    if (key) {
      byName[key] = toPlainObject(rawValue);
    }
  }

  return byName;
}

function normalizeRequired(rawRequired) {
  if (!Array.isArray(rawRequired)) {
    return [];
  }

  return [...new Set(rawRequired.map(normalizeAddressName).filter(Boolean))];
}

const CREATION_DEFAULTS = Object.freeze({
  payloadStrategy: DEFAULT_BP_PAYLOAD_STRATEGY,
  contactEmployeeSource: DEFAULT_CONTACT_EMPLOYEE_SOURCE,
  defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
  addresses: { strategy: DEFAULT_BP_ADDRESS_STRATEGY, byName: {}, required: [] },
});

function buildCreationDefaults() {
  return {
    payloadStrategy: CREATION_DEFAULTS.payloadStrategy,
    contactEmployeeSource: CREATION_DEFAULTS.contactEmployeeSource,
    defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
    addresses: { strategy: CREATION_DEFAULTS.addresses.strategy, byName: {}, required: [] },
  };
}

function buildPropertiesFlagsDefaults() {
  return {
    strategy: DEFAULT_PROPERTIES_FLAGS_STRATEGY,
    hubspotProperty: null,
    min: DEFAULT_PROPERTIES_MIN,
    max: DEFAULT_PROPERTIES_MAX,
    trueValue: DEFAULT_PROPERTIES_TRUE_VALUE,
  };
}

export class BusinessPartnerCreationConfigRepository {
  // Nunca lanza: una config ilegible no debe tumbar un webhook de deal, solo
  // significa "usa la conducta de siempre".
  async getBusinessPartnerCreationConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, BUSINESS_PARTNER_CREATION_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildCreationDefaults();
      }

      // BPAddresses y ContactEmployees anidados son forma de SAP B1. En S/4 son
      // entidades separadas, así que la config se ignora en vez de generar un
      // payload que el gateway rechazaría.
      const sapFlavor = await resolveSapFlavor({ tenantModels: { Configuration } });

      if (sapFlavor !== SAP_FLAVORS.B1) {
        console.warn('businessPartnerCreation ignorada: solo aplica a SAP B1', { sapFlavor });
        return buildCreationDefaults();
      }

      const rawDefaults = toPlainObject(raw.defaults);
      const rawAddresses = toPlainObject(raw.addresses);

      return {
        payloadStrategy: pickAllowed(
          raw.payloadStrategy,
          Object.values(BP_PAYLOAD_STRATEGIES),
          DEFAULT_BP_PAYLOAD_STRATEGY
        ),
        contactEmployeeSource: pickAllowed(
          raw.contactEmployeeSource,
          Object.values(CONTACT_EMPLOYEE_SOURCES),
          DEFAULT_CONTACT_EMPLOYEE_SOURCE
        ),
        defaults: {
          BusinessPartner: toPlainObject(rawDefaults.BusinessPartner),
          ContactEmployee: toPlainObject(rawDefaults.ContactEmployee),
          BPAddress: toPlainObject(rawDefaults.BPAddress),
        },
        addresses: {
          strategy: pickAllowed(
            rawAddresses.strategy,
            Object.values(BP_ADDRESS_STRATEGIES),
            DEFAULT_BP_ADDRESS_STRATEGY
          ),
          byName: normalizeByName(rawAddresses.byName),
          required: normalizeRequired(rawAddresses.required),
        },
      };
    } catch (error) {
      console.error('BusinessPartner creation config read error:', error);
      return buildCreationDefaults();
    }
  }

  async getPropertiesFlagsConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const raw = await readConfiguration(Configuration, PROPERTIES_FLAGS_CONFIG_KEY);

      if (!raw || typeof raw !== 'object') {
        return buildPropertiesFlagsDefaults();
      }

      return {
        strategy: pickAllowed(
          raw.strategy,
          Object.values(PROPERTIES_FLAGS_STRATEGIES),
          DEFAULT_PROPERTIES_FLAGS_STRATEGY
        ),
        hubspotProperty: toNonEmptyString(raw.hubspotProperty),
        min: normalizeInteger(raw.min, DEFAULT_PROPERTIES_MIN),
        max: normalizeInteger(raw.max, DEFAULT_PROPERTIES_MAX),
        trueValue: toNonEmptyString(raw.trueValue) || DEFAULT_PROPERTIES_TRUE_VALUE,
      };
    } catch (error) {
      console.error('propertiesFlags config read error:', error);
      return buildPropertiesFlagsDefaults();
    }
  }
}

export default BusinessPartnerCreationConfigRepository;
