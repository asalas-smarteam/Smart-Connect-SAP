// Configuración por tenant que decide cómo se arma el payload de creación del
// BusinessPartner (HubSpot -> SAP B1). Ver
// docs/superpowers/specs/2026-08-11-business-partner-full-creation-design.md
export const BUSINESS_PARTNER_CREATION_CONFIG_KEY = 'businessPartnerCreation';

// Bidireccional: el spec SAP -> HubSpot reutiliza esta misma clave.
export const PROPERTIES_FLAGS_CONFIG_KEY = 'propertiesFlags';

export const BP_PAYLOAD_STRATEGIES = Object.freeze({
  // Reproduce campo por campo el payload que el adapter armaba antes de este
  // cambio. Ningún tenant cambia de conducta sin configurar nada.
  LEGACY_WHITELIST: 'legacyWhitelist',
  // Todo lo mapeado + defaults + BPAddresses + ContactEmployees + PropertiesN.
  FULL_MAPPED: 'fullMapped',
});

export const DEFAULT_BP_PAYLOAD_STRATEGY = BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST;

export const CONTACT_EMPLOYEE_SOURCES = Object.freeze({
  // Conducta actual: el contact del deal es el ContactEmployee, y solo cuando
  // el deal trae company y contact a la vez.
  DEAL_CONTACT: 'dealContact',
  // El workflow de HubSpot manda payload.contactEmployees; el contact del deal
  // se ignora como CE.
  PAYLOAD_ARRAY: 'payloadArray',
});

export const DEFAULT_CONTACT_EMPLOYEE_SOURCE = CONTACT_EMPLOYEE_SOURCES.DEAL_CONTACT;

export const BP_ADDRESS_STRATEGIES = Object.freeze({
  NONE: 'none',
  // El workflow de HubSpot manda payload.bpAddress como array.
  PAYLOAD_ARRAY: 'payloadArray',
});

export const DEFAULT_BP_ADDRESS_STRATEGY = BP_ADDRESS_STRATEGIES.NONE;

export const PROPERTIES_FLAGS_STRATEGIES = Object.freeze({
  NONE: 'none',
  // El valor interno de la opción del multi-select de HubSpot ES el número:
  // '55' -> Properties55: 'tYES'.
  NUMBERED_MULTI_SELECT: 'numberedMultiSelect',
});

export const DEFAULT_PROPERTIES_FLAGS_STRATEGY = PROPERTIES_FLAGS_STRATEGIES.NONE;

// Las filas de FieldMapping de las direcciones. objectType nombra la cosa del
// payload que estas filas leen (igual que line_items usa objectType 'product'),
// y un solo juego sirve tanto si el BP es company como si es contact.
export const BP_ADDRESS_OBJECT_TYPE = 'address';
export const BP_ADDRESS_SOURCE_CONTEXT = 'bpAddress';

// SAP B1 expone Properties1 .. Properties64.
export const DEFAULT_PROPERTIES_MIN = 1;
export const DEFAULT_PROPERTIES_MAX = 64;
export const DEFAULT_PROPERTIES_TRUE_VALUE = 'tYES';

export default {
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
  BP_ADDRESS_OBJECT_TYPE,
  BP_ADDRESS_SOURCE_CONTEXT,
  DEFAULT_PROPERTIES_MIN,
  DEFAULT_PROPERTIES_MAX,
  DEFAULT_PROPERTIES_TRUE_VALUE,
};
