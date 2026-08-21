// Single home for resolving a mapping `sourceField` path against a SAP record.
// This logic used to be duplicated verbatim in field-mapping.service.js (which
// maps contacts) and MappingSyncRepository.js (which maps companies), so a fix
// applied to one silently missed the other.
import {
  SAP_BOOLEAN_FALSE,
  SAP_BOOLEAN_SOURCE_FIELDS,
  SAP_BOOLEAN_TRUE,
} from '#domain/sap/sap-boolean-fields.constants.js';

const SAP_BOOLEAN_FIELD_SET = new Set(
  SAP_BOOLEAN_SOURCE_FIELDS.map((field) => field.toLowerCase())
);

// 'tYES'/'tNO' -> true/false. Cualquier otra cosa vuelve intacta: un valor
// inesperado tiene que llegar visible a HubSpot en vez de convertirse en un
// false plausible pero inventado, que nadie detecta mirando una casilla.
export function normalizeSapBoolean(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === SAP_BOOLEAN_TRUE.toLowerCase()) {
    return true;
  }

  if (normalized === SAP_BOOLEAN_FALSE.toLowerCase()) {
    return false;
  }

  return value;
}

// Se compara el ULTIMO segmento del path: la lista nombra el campo de SAP, así
// que un mapeo anidado ('to_Customer.InventoryItem') cuenta igual que el plano.
function isSapBooleanField(sourceField) {
  if (!sourceField) {
    return false;
  }

  const segments = String(sourceField).split('.');
  const lastSegment = segments[segments.length - 1].trim().toLowerCase();

  return SAP_BOOLEAN_FIELD_SET.has(lastSegment);
}

// A blank string is a GAP, not a value: SAP fills either BPTaxNumber or
// BPTaxLongNumber per tax type and leaves the other as "". Treating "" as
// present is what makes a fallback chain stop at the wrong link. Zero and false
// are real values and must survive.
export function hasMappedValue(value) {
  return value !== null && typeof value !== 'undefined' && String(value).trim() !== '';
}

// Stable ordering by a configured list of values. Entries whose value is not in
// the list go last and keep their relative order, so adding a priority never
// hides a row it does not mention.
function orderByPriority(items, rule) {
  const order = Array.isArray(rule?.order) ? rule.order : null;

  if (!rule?.field || !order || order.length === 0) {
    return items;
  }

  const rank = new Map(order.map((value, index) => [String(value), index]));

  return items
    .map((item, index) => ({
      item,
      index,
      rank: rank.get(String(item?.[rule.field])) ?? order.length,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

function walk(current, segments, options, navProperty) {
  if (current === null || typeof current === 'undefined') {
    return null;
  }

  if (Array.isArray(current)) {
    if (!options.scanCollections) {
      // Legacy behaviour: blindly the first row, even when it is blank.
      return walk(current[0], segments, options, navProperty);
    }

    const ordered = orderByPriority(current, options.collectionPriority?.[navProperty]);

    for (const item of ordered) {
      const value = walk(item, segments, options, navProperty);
      if (hasMappedValue(value)) {
        return value;
      }
    }

    // Nothing carried a value: answer from the winning row anyway so the caller
    // sees "" rather than null and can tell "empty in SAP" from "no such path".
    return ordered.length > 0 ? walk(ordered[0], segments, options, navProperty) : null;
  }

  if (segments.length === 0) {
    return current ?? null;
  }

  const [segment, ...rest] = segments;
  // The navigation property is remembered so a collection reached through it can
  // be ordered by the rule configured for that property.
  return walk(current?.[segment], rest, options, segment);
}

export function resolveValueByPath(inputData, sourceField, options = {}) {
  if (!sourceField) {
    return null;
  }

  const segments = String(sourceField)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  return walk(inputData, segments, options, null);
}

// Applies every active mapping to one record.
//
// With `fallbackConfig.enabled`, several mappings on the same `targetField` form
// an ordered fallback chain (mappings arrive sorted by `_id`): the first one that
// yields a value wins and no later row can blank it out. Disabled, the last row
// wins unconditionally -- including when it resolves to null, which is how a
// second `cedula` row wiped the field for every company.
export function buildMappedProperties({ input, mappings, fallbackConfig = null }) {
  const properties = {};
  const chainEnabled = fallbackConfig?.enabled === true;
  const options = {
    scanCollections: chainEnabled,
    collectionPriority: fallbackConfig?.collectionPriority ?? null,
  };

  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    if ((mapping?.isActive ?? true) === false) {
      continue;
    }

    const { targetField } = mapping;

    if (chainEnabled
      && Object.prototype.hasOwnProperty.call(properties, targetField)
      && hasMappedValue(properties[targetField])) {
      continue;
    }

    const value = resolveValueByPath(input, mapping.sourceField, options);

    properties[targetField] = isSapBooleanField(mapping.sourceField)
      ? normalizeSapBoolean(value)
      : value;
  }

  return properties;
}

export default {
  buildMappedProperties,
  hasMappedValue,
  normalizeSapBoolean,
  resolveValueByPath,
};
