// Task types a ClientConfig document can drive. SAP_SYNC is the historical
// behavior (fetch SAP records -> upsert HubSpot objects). DROPDOWN_OPTIONS only
// rewrites the option list of enumeration properties: it never reads or writes
// a single CRM record, so it shares the scheduler but not the sync pipeline.
export const CLIENT_CONFIG_TASK_TYPES = Object.freeze({
  SAP_SYNC: 'SAP_SYNC',
  DROPDOWN_OPTIONS: 'DROPDOWN_OPTIONS',
});

export const CLIENT_CONFIG_TASK_TYPE_VALUES = Object.freeze(
  Object.values(CLIENT_CONFIG_TASK_TYPES)
);

// Configs created before this field existed have no taskType, so the absent
// value must resolve to the historical behavior.
export const DEFAULT_CLIENT_CONFIG_TASK_TYPE = CLIENT_CONFIG_TASK_TYPES.SAP_SYNC;

export function resolveClientConfigTaskType(value) {
  const raw = String(value ?? '').trim().toUpperCase();

  return CLIENT_CONFIG_TASK_TYPE_VALUES.includes(raw)
    ? raw
    : DEFAULT_CLIENT_CONFIG_TASK_TYPE;
}

// Key in the tenant `Configurations` collection that decides whether the client
// wants dropdown sync at all, and what to read.
export const DROPDOWN_OPTIONS_CONFIG_KEY = 'dropdownOptionsSync';

export const DROPDOWN_SOURCE_TYPES = Object.freeze({
  COLLECTION: 'collection',
  UDF: 'udf',
});

// B1 keeps user-defined field metadata in UserFieldsMD: one row per UDF, its
// allowed values nested under ValidValuesMD, and its name stripped of the `U_`
// prefix that BusinessPartners payloads use. `fieldNameField` is what turns the
// generic engine into per-row mode -- each row feeds its own field instead of
// all rows feeding one shared option list.
export const UDF_SOURCE_DEFAULTS = Object.freeze({
  serviceLayerPath: '/UserFieldsMD',
  optionsPath: 'ValidValuesMD',
  valueField: 'Value',
  labelField: 'Description',
  fieldNameField: 'Name',
  fieldNamePrefix: 'U_',
});

// HubSpot caps enumeration properties at 1000 options.
export const HUBSPOT_MAX_PROPERTY_OPTIONS = 1000;

// HubSpot joins multi-select values with ';', so a value containing one cannot
// be read back unambiguously and is refused rather than silently corrupted.
export const HUBSPOT_OPTION_VALUE_SEPARATOR = ';';

export const DROPDOWN_WARNING_CODES = Object.freeze({
  UNSUPPORTED_SAP_FLAVOR: 'DROPDOWN_UNSUPPORTED_SAP_FLAVOR',
  INVALID_SOURCE: 'DROPDOWN_INVALID_SOURCE',
  SOURCE_FETCH_FAILED: 'DROPDOWN_SOURCE_FETCH_FAILED',
  NO_OPTIONS: 'DROPDOWN_SOURCE_RETURNED_NO_OPTIONS',
  INVALID_OPTION_VALUE: 'DROPDOWN_INVALID_OPTION_VALUE',
  OPTIONS_SKIPPED: 'DROPDOWN_OPTIONS_SKIPPED',
  OPTIONS_TRUNCATED: 'DROPDOWN_OPTIONS_TRUNCATED',
  FIELD_WITHOUT_MAPPING: 'DROPDOWN_FIELD_WITHOUT_MAPPING',
  TARGET_CONFLICT: 'DROPDOWN_TARGET_CONFLICT',
  PROPERTY_NAME_INVALID: 'DROPDOWN_PROPERTY_NAME_INVALID',
  PROPERTY_NOT_FOUND: 'DROPDOWN_PROPERTY_NOT_FOUND',
  PROPERTY_NOT_ENUMERATION: 'DROPDOWN_PROPERTY_NOT_ENUMERATION',
  PROPERTY_READ_ONLY: 'DROPDOWN_PROPERTY_READ_ONLY',
  PROPERTY_UPDATE_FAILED: 'DROPDOWN_PROPERTY_UPDATE_FAILED',
});

export default {
  CLIENT_CONFIG_TASK_TYPES,
  CLIENT_CONFIG_TASK_TYPE_VALUES,
  DEFAULT_CLIENT_CONFIG_TASK_TYPE,
  DROPDOWN_OPTIONS_CONFIG_KEY,
  DROPDOWN_SOURCE_TYPES,
  DROPDOWN_WARNING_CODES,
  HUBSPOT_MAX_PROPERTY_OPTIONS,
  HUBSPOT_OPTION_VALUE_SEPARATOR,
  UDF_SOURCE_DEFAULTS,
  resolveClientConfigTaskType,
};
