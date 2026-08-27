// Single home for resolving a mapping `sourceField` path against a SAP record.
// This logic used to be duplicated verbatim in field-mapping.service.js (which
// maps contacts) and MappingSyncRepository.js (which maps companies), so a fix
// applied to one silently missed the other.
import {
  SAP_BOOLEAN_FALSE,
  SAP_BOOLEAN_SOURCE_FIELDS,
  SAP_BOOLEAN_TRUE,
} from '#domain/sap/sap-boolean-fields.constants.js';
import { HUBSPOT_PHONE_TARGET_FIELDS } from '#domain/sap/hubspot-phone-fields.constants.js';

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

const HUBSPOT_PHONE_FIELD_SET = new Set(
  HUBSPOT_PHONE_TARGET_FIELDS.map((field) => field.toLowerCase())
);

// E.164: '+', un primer dígito 1-9 y hasta 15 dígitos en total. Es lo que pide
// HubSpot cuando el portal tiene la validación de teléfono activada.
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

// 'ext 123', 'ext. 123' o 'x123' al final. HubSpot acepta la extensión separada
// del número, así que se preserva en vez de tirar el teléfono completo.
const EXTENSION_PATTERN = /\s*(?:ext|extension|x)\.?\s*(\d{1,6})\s*$/i;

// Separadores que la gente escribe en SAP y que no cambian el número.
const COSMETIC_PATTERN = /[\s()\-.]/g;

// Un teléfono que no se puede volver E.164 se va como null A PROPÓSITO.
//
// No se le pega un código de país deducido: '3192 3094' son 8 dígitos y eso es
// ambiguo entre +506 (Costa Rica) y +502 (Guatemala), así que adivinar produce
// un número válido pero equivocado, que nadie detecta nunca. Y no se deja pasar
// intacto porque HubSpot responde 400 INVALID_PHONE_NUMBER y ahí se pierde el
// registro COMPLETO -- nombre, email, cédula --, no solo el teléfono.
//
// Lo único que se arregla es lo cosmético sobre un número que YA trae su país:
// '+506 3192 3094' -> '+50631923094'. Ahí no se inventa nada.
export function normalizeHubspotPhone(value) {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  const raw = String(value).trim();

  // '' (o solo espacios) es un HUECO, no un teléfono inválido: significa que el
  // campo existe en SAP y está vacío, y la cadena de fallback usa esa
  // distinción. Se devuelve el valor original sin tocarlo.
  if (raw === '') {
    return value;
  }

  const extensionMatch = EXTENSION_PATTERN.exec(raw);
  const extension = extensionMatch ? extensionMatch[1] : null;
  const numberPart = extensionMatch ? raw.slice(0, extensionMatch.index) : raw;

  const compact = numberPart.replace(COSMETIC_PATTERN, '');

  if (!E164_PATTERN.test(compact)) {
    return null;
  }

  return extension ? `${compact} ext ${extension}` : compact;
}

// Por targetField y no por sourceField: la validación que falla es la de la
// propiedad de HubSpot, así que da igual de qué campo de SAP venga el dato.
function isHubspotPhoneField(targetField) {
  if (!targetField) {
    return false;
  }

  return HUBSPOT_PHONE_FIELD_SET.has(String(targetField).trim().toLowerCase());
}

// Único lugar donde se decide qué normalización aplica a un valor mapeado. Las
// dos reglas son excluyentes: los booleanos van por el campo de SAP, los
// teléfonos por la propiedad de HubSpot.
function normalizeMappedValue({ value, sourceField, targetField }) {
  if (isSapBooleanField(sourceField)) {
    return normalizeSapBoolean(value);
  }

  if (isHubspotPhoneField(targetField)) {
    return normalizeHubspotPhone(value);
  }

  return value;
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

    // Se normaliza ANTES de asignar, no después: así un teléfono inválido queda
    // en null, hasMappedValue(null) es false y el siguiente eslabón de la cadena
    // de fallback todavía tiene su turno.
    properties[targetField] = normalizeMappedValue({
      value,
      sourceField: mapping.sourceField,
      targetField,
    });
  }

  return properties;
}

export default {
  buildMappedProperties,
  hasMappedValue,
  normalizeHubspotPhone,
  normalizeSapBoolean,
  resolveValueByPath,
};
