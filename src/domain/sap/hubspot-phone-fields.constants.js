// HubSpot valida las propiedades de teléfono cuando el portal tiene activada la
// validación de número: exige E.164 ('+' + código de país + dígitos, hasta 15),
// opcionalmente con extensión. Cualquier otra cosa hace que la API responda 400
// con INVALID_PHONE_NUMBER y el registro COMPLETO se queda sin sincronizar, no
// solo el teléfono.
//
// SAP B1 no guarda el teléfono en E.164: OCRD.Phone1 es texto libre y el usuario
// escribe '3192 3094', '2222-3333', '8888 9999 / 2222 1111' o lo que sea.
//
// La conversión es por TARGET field, no por source, porque la validación que
// falla es la de la propiedad de HubSpot: da igual de qué campo de SAP venga el
// dato, si aterriza en `phone` tiene que ser E.164. Es la diferencia con
// SAP_BOOLEAN_SOURCE_FIELDS, que sí va por source porque ahí el problema es el
// enum de SAP.

// Documento por tenant que dice dos cosas que el connector no puede deducir:
// (a) cuáles de los targetFields del fieldMapping son teléfonos -- el mapeo solo
// conoce nombres de propiedad, no su tipo, y pueden ser varios ('phone',
// 'mobilephone', una propiedad custom) -- y (b) con qué código de país completar
// un número local. El código correcto es del TENANT, no del connector: +502 para
// Guatemala, +506 para Costa Rica.
export const PHONE_NORMALIZATION_CONFIG_KEY = 'phoneNormalization';

// Lista que aplica cuando la config no declara `targetFields`. Arranca solo con
// 'phone' a propósito: es el único targetField de teléfono que existía en los
// mapeos cuando esto se hardcodeó, y nulificar una propiedad que ningún cliente
// pidió tocar es pérdida de dato silenciosa.
export const HUBSPOT_PHONE_TARGET_FIELDS = Object.freeze([
  'phone',
]);

// E.164 admite 15 dígitos EN TOTAL, contando el código de país.
export const E164_MAX_DIGITS = 15;

// Config ausente = conducta histórica exacta: se limpia lo cosmético de un
// número que YA trae su país ('+506 3192 3094' -> '+50631923094') y lo demás se
// va en null. Ningún tenant existente cambia hasta que edite el documento.
export const DEFAULT_PHONE_NORMALIZATION_CONFIG = Object.freeze({
  enabled: false,
  defaultCountryCode: null,
  nationalNumberLengths: Object.freeze([]),
  targetFields: HUBSPOT_PHONE_TARGET_FIELDS,
});

// Acepta '+502' y '502', y devuelve siempre '+502'. Hasta 3 dígitos porque no
// existe código de país más largo, y el primero no puede ser 0.
const COUNTRY_CODE_PATTERN = /^\+?([1-9]\d{0,2})$/;

function normalizeCountryCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const match = COUNTRY_CODE_PATTERN.exec(String(value).trim());

  return match ? `+${match[1]}` : null;
}

// Largos del número LOCAL, sin código de país (Guatemala y Costa Rica: 8). Se
// acepta un número suelto además del array porque un tenant con un solo largo
// escribe `8` antes que `[8]`, y rechazarlo por la forma no protege de nada.
// Se descarta el largo que no cabe en E.164 junto al código de país: prefijarlo
// produciría un número que HubSpot rechaza igual.
function normalizeNationalNumberLengths(value, countryCode) {
  const raw = Array.isArray(value) ? value : [value];
  const countryDigits = countryCode ? countryCode.length - 1 : 0;
  const maxLength = E164_MAX_DIGITS - countryDigits;

  const lengths = raw
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0 && entry <= maxLength);

  return Object.freeze([...new Set(lengths)].sort((a, b) => a - b));
}

// Se guardan en minúsculas porque los nombres internos de propiedad de HubSpot
// lo son, y quien escribe la config no tiene por qué saberlo.
function normalizeTargetFields(value) {
  if (typeof value === 'undefined' || value === null) {
    return HUBSPOT_PHONE_TARGET_FIELDS;
  }

  const raw = Array.isArray(value) ? value : [value];

  const fields = raw
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  // Una lista vacía o toda inválida NO apaga la normalización: dejaría pasar a
  // HubSpot el mismo texto libre que hoy se limpia y el 400 vuelve. Cae al
  // default, que es la conducta que ese tenant ya tenía.
  return fields.length > 0 ? Object.freeze([...new Set(fields)]) : HUBSPOT_PHONE_TARGET_FIELDS;
}

// Devuelve siempre una config usable; nunca lanza.
//
// `enabled` exige AMBOS: código de país y largo(s) del número local. Sin el
// largo no se puede distinguir un número local de uno que ya trae el país pegado
// sin '+' ('50231923094'), y prefijar a ciegas produce un número válido para
// HubSpot pero equivocado ('+502' + '50231923094'), que nadie detecta mirando
// una ficha. Ante la duda queda el null que ya existía: el hueco se ve y se
// corrige en SAP.
export function normalizePhoneNormalizationConfig(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return DEFAULT_PHONE_NORMALIZATION_CONFIG;
  }

  const targetFields = normalizeTargetFields(rawValue.targetFields);
  const defaultCountryCode = normalizeCountryCode(rawValue.defaultCountryCode);
  const nationalNumberLengths = normalizeNationalNumberLengths(
    rawValue.nationalNumberLengths,
    defaultCountryCode
  );

  const enabled = rawValue.enabled === true
    && defaultCountryCode !== null
    && nationalNumberLengths.length > 0;

  return Object.freeze({
    enabled,
    defaultCountryCode: enabled ? defaultCountryCode : null,
    nationalNumberLengths: enabled ? nationalNumberLengths : Object.freeze([]),
    targetFields,
  });
}

// true cuando el tenant pidió prefijar pero la config no alcanza para hacerlo.
// Lo usa el repositorio para dejar rastro: un `enabled: true` que no prefija
// nada y no dice por qué es una tarde perdida buscando el bug en otro lado.
export function isIncompletePhoneNormalizationConfig(rawValue, normalizedConfig) {
  return rawValue?.enabled === true && normalizedConfig?.enabled !== true;
}

export default {
  PHONE_NORMALIZATION_CONFIG_KEY,
  HUBSPOT_PHONE_TARGET_FIELDS,
  E164_MAX_DIGITS,
  DEFAULT_PHONE_NORMALIZATION_CONFIG,
  normalizePhoneNormalizationConfig,
  isIncompletePhoneNormalizationConfig,
};
