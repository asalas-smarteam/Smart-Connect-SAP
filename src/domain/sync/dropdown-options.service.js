import {
  DROPDOWN_SOURCE_TYPES,
  DROPDOWN_WARNING_CODES,
  HUBSPOT_MAX_PROPERTY_OPTIONS,
  HUBSPOT_OPTION_VALUE_SEPARATOR,
  UDF_SOURCE_DEFAULTS,
} from './dropdown-options.constants.js';

function toTrimmedString(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'object') {
    return '';
  }

  return String(value).trim();
}

// Dotted paths so a source can point at a nested property without needing code
// (`Details/Code` style payloads show up in user tables).
function resolveByPath(source, path) {
  const segments = String(path || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return undefined;
  }

  return segments.reduce(
    (current, segment) =>
      current !== null && typeof current === 'object' ? current[segment] : undefined,
    source
  );
}

function normalizeFieldList(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return [...new Set(list.map(toTrimmedString).filter(Boolean))];
}

// Query values are stored raw in the config so a human can read the $filter,
// but the B1 transport forwards them untouched -- encoding belongs to whoever
// builds the URL, so it happens here, once.
function normalizeQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return {};
  }

  return Object.entries(query).reduce((accumulator, [key, value]) => {
    const normalizedKey = toTrimmedString(key);
    const normalizedValue = toTrimmedString(value);

    if (normalizedKey && normalizedValue) {
      accumulator[normalizedKey] = normalizedValue;
    }

    return accumulator;
  }, {});
}

function normalizeSourceType(value) {
  const raw = String(value ?? '').trim().toLowerCase();

  if (raw === DROPDOWN_SOURCE_TYPES.UDF) {
    return DROPDOWN_SOURCE_TYPES.UDF;
  }

  return DROPDOWN_SOURCE_TYPES.COLLECTION;
}

// A UDF entry is shorthand: it expands into the same generic shape a collection
// source uses, so the extraction engine has a single code path.
function expandUdfSource(rawSource) {
  const tableName = toTrimmedString(rawSource?.tableName);

  if (!tableName) {
    return { error: 'tableName is required for a udf source' };
  }

  const query = normalizeQuery(rawSource?.query);

  return {
    expanded: {
      ...UDF_SOURCE_DEFAULTS,
      ...rawSource,
      serviceLayerPath: toTrimmedString(rawSource?.serviceLayerPath)
        || UDF_SOURCE_DEFAULTS.serviceLayerPath,
      query: Object.keys(query).length > 0
        ? query
        : { $filter: `TableName eq '${tableName}'` },
      tableName,
    },
  };
}

export function normalizeDropdownSource(rawSource, index = 0) {
  const id = `sources[${index}]`;

  if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
    return { id, index, error: 'source must be an object' };
  }

  const sourceType = normalizeSourceType(rawSource.sourceType);
  let candidate = rawSource;

  if (sourceType === DROPDOWN_SOURCE_TYPES.UDF) {
    const { expanded, error } = expandUdfSource(rawSource);

    if (error) {
      return { id, index, error };
    }

    candidate = expanded;
  }

  const serviceLayerPath = toTrimmedString(candidate.serviceLayerPath);
  const valueField = toTrimmedString(candidate.valueField);
  const fields = normalizeFieldList(candidate.fields);

  if (!serviceLayerPath) {
    return { id, index, error: 'serviceLayerPath is required' };
  }

  if (!valueField) {
    return { id, index, error: 'valueField is required' };
  }

  if (fields.length === 0) {
    return { id, index, error: 'fields must contain at least one SAP field name' };
  }

  return {
    source: {
      id,
      index,
      label: toTrimmedString(candidate.label) || serviceLayerPath,
      sourceType,
      serviceLayerPath: serviceLayerPath.startsWith('/')
        ? serviceLayerPath
        : `/${serviceLayerPath}`,
      query: normalizeQuery(candidate.query),
      optionsPath: toTrimmedString(candidate.optionsPath) || null,
      valueField,
      labelField: toTrimmedString(candidate.labelField) || null,
      fieldNameField: toTrimmedString(candidate.fieldNameField) || null,
      fieldNamePrefix: toTrimmedString(candidate.fieldNamePrefix),
      tableName: toTrimmedString(candidate.tableName) || null,
      fields,
    },
  };
}

// Accepts both the documented `{ enabled, sources }` object and a bare array of
// sources, because a bare array is the shape people reach for first and
// rejecting it would only produce a silent no-op run.
export function normalizeDropdownOptionsConfig(rawValue) {
  const container = Array.isArray(rawValue)
    ? { enabled: true, sources: rawValue }
    : (rawValue && typeof rawValue === 'object' ? rawValue : null);

  if (!container) {
    return { enabled: false, sources: [], invalidSources: [] };
  }

  const rawSources = Array.isArray(container.sources) ? container.sources : [];
  const normalized = rawSources.map((source, index) => normalizeDropdownSource(source, index));
  const sources = normalized.filter((entry) => entry.source).map((entry) => entry.source);
  const invalidSources = normalized
    .filter((entry) => entry.error)
    .map(({ id, index, error }) => ({ id, index, error }));

  return {
    // Absent flag with sources present reads as "yes"; only an explicit false
    // (or a missing document) turns the feature off.
    enabled: container.enabled !== false && (sources.length > 0 || invalidSources.length > 0),
    sources,
    invalidSources,
  };
}

function buildOptions(rawItems, { valueField, labelField }) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const options = [];
  const seen = new Set();
  const rejected = [];

  items.forEach((item) => {
    if (item === null || typeof item === 'undefined') {
      return;
    }

    const value = toTrimmedString(resolveByPath(item, valueField));

    if (!value) {
      return;
    }

    if (value.includes(HUBSPOT_OPTION_VALUE_SEPARATOR)) {
      rejected.push(value);
      return;
    }

    if (seen.has(value)) {
      return;
    }

    seen.add(value);
    options.push({
      value,
      label: (labelField ? toTrimmedString(resolveByPath(item, labelField)) : '') || value,
    });
  });

  return { options, rejected };
}

function capOptions(options) {
  if (options.length <= HUBSPOT_MAX_PROPERTY_OPTIONS) {
    return { options, truncated: 0 };
  }

  return {
    options: options.slice(0, HUBSPOT_MAX_PROPERTY_OPTIONS),
    truncated: options.length - HUBSPOT_MAX_PROPERTY_OPTIONS,
  };
}

function buildIssue({ code, field, message, details }) {
  return {
    code,
    field: field ?? null,
    message,
    details: details ?? null,
  };
}

function collectIssuesForOptions({ source, field, rejected, truncated }) {
  const issues = [];

  if (rejected.length > 0) {
    issues.push(buildIssue({
      code: DROPDOWN_WARNING_CODES.INVALID_OPTION_VALUE,
      field,
      message: `${rejected.length} option(s) skipped because the SAP value contains '${HUBSPOT_OPTION_VALUE_SEPARATOR}', which HubSpot uses as its value separator`,
      details: { source: source.id, serviceLayerPath: source.serviceLayerPath, samples: rejected.slice(0, 5) },
    }));
  }

  if (truncated > 0) {
    issues.push(buildIssue({
      code: DROPDOWN_WARNING_CODES.OPTIONS_TRUNCATED,
      field,
      message: `SAP returned more than ${HUBSPOT_MAX_PROPERTY_OPTIONS} options; ${truncated} were dropped to stay within the HubSpot limit`,
      details: { source: source.id, serviceLayerPath: source.serviceLayerPath, truncated },
    }));
  }

  return issues;
}

// Per-row mode (`fieldNameField`): every row carries its own option list and
// names the field it belongs to -- this is how UserFieldsMD works.
function extractPerRow({ source, rows }) {
  const optionSets = [];
  const issues = [];
  const requested = new Set(source.fields);
  const matched = new Set();

  rows.forEach((row) => {
    const rawName = toTrimmedString(resolveByPath(row, source.fieldNameField));

    if (!rawName) {
      return;
    }

    const field = `${source.fieldNamePrefix}${rawName}`;

    if (!requested.has(field)) {
      return;
    }

    matched.add(field);

    const rawItems = source.optionsPath ? resolveByPath(row, source.optionsPath) : [row];
    const { options, rejected } = buildOptions(rawItems, source);
    const { options: capped, truncated } = capOptions(options);

    issues.push(...collectIssuesForOptions({ source, field, rejected, truncated }));

    if (capped.length === 0) {
      issues.push(buildIssue({
        code: DROPDOWN_WARNING_CODES.NO_OPTIONS,
        field,
        message: `SAP returned no usable options for ${field}`,
        details: { source: source.id, serviceLayerPath: source.serviceLayerPath },
      }));
      return;
    }

    optionSets.push({ field, options: capped });
  });

  source.fields
    .filter((field) => !matched.has(field))
    .forEach((field) => {
      issues.push(buildIssue({
        code: DROPDOWN_WARNING_CODES.NO_OPTIONS,
        field,
        message: `SAP did not return a definition for ${field}`,
        details: {
          source: source.id,
          serviceLayerPath: source.serviceLayerPath,
          ...(source.tableName ? { tableName: source.tableName } : {}),
        },
      }));
    });

  return { optionSets, issues };
}

// Shared mode: every row contributes to one option list, applied to each of the
// source's fields.
function extractShared({ source, rows }) {
  const rawItems = source.optionsPath
    ? rows.flatMap((row) => {
      const nested = resolveByPath(row, source.optionsPath);
      return Array.isArray(nested) ? nested : [];
    })
    : rows;
  const { options, rejected } = buildOptions(rawItems, source);
  const { options: capped, truncated } = capOptions(options);
  const issues = collectIssuesForOptions({ source, field: null, rejected, truncated });

  if (capped.length === 0) {
    issues.push(buildIssue({
      code: DROPDOWN_WARNING_CODES.NO_OPTIONS,
      field: null,
      message: `SAP returned no usable options for ${source.serviceLayerPath}`,
      details: { source: source.id, serviceLayerPath: source.serviceLayerPath, fields: source.fields },
    }));

    return { optionSets: [], issues };
  }

  return {
    optionSets: source.fields.map((field) => ({ field, options: capped })),
    issues,
  };
}

export function extractOptionSets({ source, rows }) {
  const safeRows = Array.isArray(rows) ? rows : [];

  return source.fieldNameField
    ? extractPerRow({ source, rows: safeRows })
    : extractShared({ source, rows: safeRows });
}

function normalizeExistingOption(option) {
  if (!option || typeof option !== 'object') {
    return null;
  }

  const value = toTrimmedString(option.value);

  if (!value) {
    return null;
  }

  return {
    value,
    label: toTrimmedString(option.label) || value,
    description: typeof option.description === 'string' ? option.description : null,
    hidden: option.hidden === true,
  };
}

// HubSpot has no "add one option" endpoint -- a PATCH replaces the whole array.
// So obsolete options are carried over with hidden:true instead of dropped:
// historical records keep rendering a readable label, but the option cannot be
// picked again. An option SAP brings back is un-hidden.
export function mergePropertyOptions({ existingOptions = [], sapOptions = [] } = {}) {
  const existing = (Array.isArray(existingOptions) ? existingOptions : [])
    .map(normalizeExistingOption)
    .filter(Boolean);
  const existingByValue = new Map(existing.map((option) => [option.value, option]));
  const sapValues = new Set();
  const summary = { added: 0, relabeled: 0, unhidden: 0, hidden: 0, kept: 0 };

  const merged = (Array.isArray(sapOptions) ? sapOptions : []).reduce((accumulator, option) => {
    const value = toTrimmedString(option?.value);

    if (!value || sapValues.has(value)) {
      return accumulator;
    }

    sapValues.add(value);
    const label = toTrimmedString(option?.label) || value;
    const previous = existingByValue.get(value);

    if (!previous) {
      summary.added += 1;
    } else {
      if (previous.label !== label) {
        summary.relabeled += 1;
      }

      if (previous.hidden) {
        summary.unhidden += 1;
      }

      if (previous.label === label && !previous.hidden) {
        summary.kept += 1;
      }
    }

    accumulator.push({
      label,
      value,
      displayOrder: accumulator.length,
      hidden: false,
      // A description typed by a human in HubSpot has no SAP counterpart, so it
      // survives the rewrite.
      ...(previous?.description ? { description: previous.description } : {}),
    });

    return accumulator;
  }, []);

  existing
    .filter((option) => !sapValues.has(option.value))
    .forEach((option) => {
      if (!option.hidden) {
        summary.hidden += 1;
      }

      merged.push({
        label: option.label,
        value: option.value,
        displayOrder: merged.length,
        hidden: true,
        ...(option.description ? { description: option.description } : {}),
      });
    });

  return { options: merged, summary };
}

function toComparableOption(option) {
  return [
    toTrimmedString(option?.value),
    toTrimmedString(option?.label),
    option?.hidden === true ? '1' : '0',
  ].join(' ');
}

// Compared in order, because displayOrder is what HubSpot renders and a
// reordering is a real change worth a PATCH.
export function propertyOptionsAreEqual(left, right) {
  const a = (Array.isArray(left) ? left : []).map(normalizeExistingOption).filter(Boolean);
  const b = (Array.isArray(right) ? right : []).map(normalizeExistingOption).filter(Boolean);

  if (a.length !== b.length) {
    return false;
  }

  return a.every((option, index) => toComparableOption(option) === toComparableOption(b[index]));
}

// HubSpot internal property names are lowercase, so a mapping whose targetField
// carries an uppercase letter ('GroupCode' instead of 'groupcode') can never
// match a real property. Caught before the API call because the failure is
// otherwise silent in the record pipeline too: sanitizeProperties matches names
// against a case-sensitive Set and simply drops the unknown one.
export function validateHubspotPropertyName(propertyName) {
  const name = toTrimmedString(propertyName);

  if (!name) {
    return { valid: false, reason: 'the mapping has an empty targetField' };
  }

  if (name !== name.toLowerCase()) {
    return {
      valid: false,
      reason: `HubSpot property names are lowercase, so '${name}' cannot exist; the mapping's targetField should be '${name.toLowerCase()}'`,
    };
  }

  return { valid: true, reason: null };
}

// HubSpot marks properties it owns as read-only definitions; PATCHing their
// options fails, so they are reported instead of attempted.
export function classifyTargetProperty(property) {
  if (!property) {
    return {
      writable: false,
      code: DROPDOWN_WARNING_CODES.PROPERTY_NOT_FOUND,
      message: 'property does not exist in HubSpot',
    };
  }

  if (property.type !== 'enumeration') {
    return {
      writable: false,
      code: DROPDOWN_WARNING_CODES.PROPERTY_NOT_ENUMERATION,
      message: `property exists as '${property.type ?? 'unknown'}' and HubSpot does not allow changing a property type, so it cannot become a dropdown`,
    };
  }

  if (property.modificationMetadata?.readOnlyDefinition === true) {
    return {
      writable: false,
      code: DROPDOWN_WARNING_CODES.PROPERTY_READ_ONLY,
      message: 'property definition is read-only in HubSpot and its options cannot be rewritten',
    };
  }

  return { writable: true, code: null, message: null };
}

export default {
  classifyTargetProperty,
  extractOptionSets,
  mergePropertyOptions,
  normalizeDropdownOptionsConfig,
  normalizeDropdownSource,
  propertyOptionsAreEqual,
  validateHubspotPropertyName,
};
