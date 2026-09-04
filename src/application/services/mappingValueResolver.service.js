// Single home for resolving a mapping `sourceField` path against a SAP record.
// This logic used to be duplicated verbatim in field-mapping.service.js (which
// maps contacts) and MappingSyncRepository.js (which maps companies), so a fix
// applied to one silently missed the other.
import {
  SAP_BOOLEAN_FALSE,
  SAP_BOOLEAN_SOURCE_FIELDS,
  SAP_BOOLEAN_TRUE,
} from '#domain/sap/sap-boolean-fields.constants.js';
import {
  DEFAULT_PHONE_NORMALIZATION_CONFIG,
  normalizePhoneNormalizationConfig,
} from '#domain/sap/hubspot-phone-fields.constants.js';
import {
  isOwnerFieldMapping,
  translateSapOwnerValue,
} from '#domain/owners/owner-directory.service.js';

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

// E.164: '+', un primer dígito 1-9 y hasta 15 dígitos en total. Es lo que pide
// HubSpot cuando el portal tiene la validación de teléfono activada.
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

const DIGITS_ONLY_PATTERN = /^\d+$/;

// 'ext 123', 'ext. 123' o 'x123' al final. HubSpot acepta la extensión separada
// del número, así que se preserva en vez de tirar el teléfono completo.
const EXTENSION_PATTERN = /\s*(?:ext|extension|x)\.?\s*(\d{1,6})\s*$/i;

// Separadores que la gente escribe en SAP y que no cambian el número.
const COSMETIC_PATTERN = /[\s()\-.]/g;

// Completa un número LOCAL con el código de país que el tenant declaró en
// `phoneNormalization`. Devuelve null cuando no hay nada seguro que hacer.
//
// El orden de las dos reglas no es casual. Con defaultCountryCode '+502' y
// nationalNumberLengths [8]:
//   '31923094'    -> 8 dígitos = largo local  -> '+50231923094'
//   '50231923094' -> 11 dígitos; 11 - 3 = 8   -> '+50231923094' (ya traía país)
// Se prueba primero el largo local porque un número local que POR CASUALIDAD
// empieza con los dígitos del país ('50212345' en Guatemala) sigue siendo local.
// Al revés, esos 8 dígitos se leerían como país + 5 y saldría un número que no
// existe.
function applyDefaultCountryCode(compact, phoneConfig) {
  if (phoneConfig?.enabled !== true) {
    return null;
  }

  // Lo que trae '+' y no pasó E.164 ya es basura ('+', '+0123456789', dos
  // números pegados): prefijarlo solo produce basura más larga.
  if (!DIGITS_ONLY_PATTERN.test(compact)) {
    return null;
  }

  const { defaultCountryCode, nationalNumberLengths } = phoneConfig;

  // `normalizeHubspotPhone` es público y puede recibir una config cruda que no
  // pasó por normalizePhoneNormalizationConfig. Sin país o sin largo no hay nada
  // que hacer, y leerlos igual sería un TypeError en medio de un sync.
  if (typeof defaultCountryCode !== 'string' || !Array.isArray(nationalNumberLengths)) {
    return null;
  }

  const countryDigits = defaultCountryCode.slice(1);

  let candidate = null;

  if (nationalNumberLengths.includes(compact.length)) {
    candidate = `${defaultCountryCode}${compact}`;
  } else if (
    compact.startsWith(countryDigits)
    && nationalNumberLengths.includes(compact.length - countryDigits.length)
  ) {
    candidate = `+${compact}`;
  }

  // Se revalida en vez de confiar en la aritmética: es la única garantía de que
  // a HubSpot no le llega algo que su validación rechaza.
  return candidate && E164_PATTERN.test(candidate) ? candidate : null;
}

// Un teléfono que no se puede volver E.164 se va como null A PROPÓSITO.
//
// Sin config de tenant NO se le pega un código de país: '3192 3094' son 8
// dígitos y eso es ambiguo entre +506 (Costa Rica) y +502 (Guatemala), así que
// adivinar produce un número válido pero equivocado, que nadie detecta nunca. Y
// no se deja pasar intacto porque HubSpot responde 400 INVALID_PHONE_NUMBER y
// ahí se pierde el registro COMPLETO -- nombre, email, cédula --, no solo el
// teléfono.
//
// Con `phoneNormalization` activa ya no se adivina: el tenant DECLARÓ su país y
// el largo de sus números locales, así que '31923094' -> '+50231923094' es lo
// que pidió. Lo que no calza con lo declarado sigue yéndose en null.
//
// Sin eso, lo único que se arregla es lo cosmético sobre un número que YA trae
// su país: '+506 3192 3094' -> '+50631923094'.
export function normalizeHubspotPhone(value, phoneConfig = DEFAULT_PHONE_NORMALIZATION_CONFIG) {
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

  const normalized = E164_PATTERN.test(compact)
    ? compact
    : applyDefaultCountryCode(compact, phoneConfig);

  if (!normalized) {
    return null;
  }

  return extension ? `${normalized} ext ${extension}` : normalized;
}

// Por targetField y no por sourceField: la validación que falla es la de la
// propiedad de HubSpot, así que da igual de qué campo de SAP venga el dato. La
// lista es del tenant (`phoneNormalization.targetFields`) porque el fieldMapping
// no distingue un teléfono de cualquier otro texto y pueden ser varios.
function isHubspotPhoneField(targetField, phoneConfig) {
  if (!targetField) {
    return false;
  }

  const fields = phoneConfig?.targetFields ?? DEFAULT_PHONE_NORMALIZATION_CONFIG.targetFields;

  return fields.includes(String(targetField).trim().toLowerCase());
}

// Único lugar donde se decide qué normalización aplica a un valor mapeado. Las
// dos reglas son excluyentes: los booleanos van por el campo de SAP, los
// teléfonos por la propiedad de HubSpot.
function normalizeMappedValue({ value, sourceField, targetField, phoneConfig }) {
  if (isSapBooleanField(sourceField)) {
    return normalizeSapBoolean(value);
  }

  if (isHubspotPhoneField(targetField, phoneConfig)) {
    return normalizeHubspotPhone(value, phoneConfig);
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
//
// `phoneConfig` ausente = conducta histórica: solo se normaliza `phone` y solo
// lo cosmético. Se normaliza la forma acá y no en cada llamador para que un
// documento a medio llenar no llegue crudo al normalizador.
// `ownerDirectory` ausente = sin traducción de usuarios, que es la conducta que
// tenía todo tenant antes de que existiera `userField` (y la que sigue teniendo
// S/4: el directorio solo se carga para B1).
export function buildMappedProperties({
  input,
  mappings,
  fallbackConfig = null,
  phoneConfig = null,
  ownerDirectory = null,
  onUnresolvedOwner = null,
}) {
  const properties = {};
  const chainEnabled = fallbackConfig?.enabled === true;
  const resolvedPhoneConfig = phoneConfig
    ? normalizePhoneNormalizationConfig(phoneConfig)
    : DEFAULT_PHONE_NORMALIZATION_CONFIG;
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

    // Los campos de usuario se resuelven acá y no en el normalizador de abajo
    // porque no son una normalización de formato: el valor se REEMPLAZA por
    // otro que sale de OwnerMappings, y cuando no hay equivalencia la clave no
    // se emite. Un `null` en su lugar borraría en HubSpot el propietario que
    // alguien puso a mano, y mandar el código de SAP tal cual (600) hace que
    // HubSpot rechace el registro completo con 400.
    if (ownerDirectory && isOwnerFieldMapping(mapping)) {
      const translation = translateSapOwnerValue({ value, directory: ownerDirectory });

      if (translation.status === 'unresolved') {
        onUnresolvedOwner?.({
          sourceField: mapping.sourceField,
          targetField,
          value,
        });
        continue;
      }

      properties[targetField] = translation.value;
      continue;
    }

    // Se normaliza ANTES de asignar, no después: así un teléfono inválido queda
    // en null, hasMappedValue(null) es false y el siguiente eslabón de la cadena
    // de fallback todavía tiene su turno.
    properties[targetField] = normalizeMappedValue({
      value,
      sourceField: mapping.sourceField,
      targetField,
      phoneConfig: resolvedPhoneConfig,
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
