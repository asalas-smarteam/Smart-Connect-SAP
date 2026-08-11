import { HUBSPOT_OPTION_VALUE_SEPARATOR } from '#domain/sync/dropdown-options.constants.js';
import { PROPERTIES_FLAGS_STRATEGIES } from './business-partner-creation.constants.js';

function isEnabled(config) {
  return config?.strategy === PROPERTIES_FLAGS_STRATEGIES.NUMBERED_MULTI_SELECT;
}

function fieldNameFor(number) {
  return `Properties${number}`;
}

// El valor de un multi-select de HubSpot llega como string unido por ';'
// ('1;2;55'). Un array se acepta por si el workflow ya lo manda desarmado.
function splitHubspotValue(hubspotValue) {
  if (Array.isArray(hubspotValue)) {
    return hubspotValue;
  }

  return String(hubspotValue ?? '').split(HUBSPOT_OPTION_VALUE_SEPARATOR);
}

// Un valor inválido nunca tumba el webhook: se reporta en `invalid` para que
// el llamador lo registre como warning y sigue con los que sí sirven.
export function parseSelectedPropertyNumbers(hubspotValue, { min, max }) {
  const selected = [];
  const invalid = [];
  const seen = new Set();

  for (const rawValue of splitHubspotValue(hubspotValue)) {
    const trimmed = String(rawValue ?? '').trim();

    if (!trimmed) {
      continue;
    }

    const parsed = Number(trimmed);

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      invalid.push(trimmed);
      continue;
    }

    if (seen.has(parsed)) {
      continue;
    }

    seen.add(parsed);
    selected.push(parsed);
  }

  return { selected: selected.sort((left, right) => left - right), invalid };
}

// HubSpot -> SAP. Solo emite las seleccionadas: en un POST de creación omitir
// un campo deja que SAP aplique su propio default.
export function buildSapPropertiesFlags({ hubspotValue, config }) {
  if (!isEnabled(config)) {
    return { flags: {}, invalid: [] };
  }

  const { selected, invalid } = parseSelectedPropertyNumbers(hubspotValue, config);
  const flags = {};

  for (const number of selected) {
    flags[fieldNameFor(number)] = config.trueValue;
  }

  return { flags, invalid };
}

// SAP -> HubSpot. Devuelve el string listo para escribir en la propiedad
// multi-select; null significa "esta strategy no aplica a este tenant", que es
// distinto de '' ("aplica y no hay ninguna seleccionada").
export function readSapPropertiesFlags({ sapRecord, config }) {
  if (!isEnabled(config)) {
    return null;
  }

  const selected = [];

  for (let number = config.min; number <= config.max; number += 1) {
    if (sapRecord?.[fieldNameFor(number)] === config.trueValue) {
      selected.push(number);
    }
  }

  return selected.join(HUBSPOT_OPTION_VALUE_SEPARATOR);
}

// Para el $select de la dirección SAP -> HubSpot.
export function listSapPropertiesFieldNames(config) {
  if (!isEnabled(config)) {
    return [];
  }

  const names = [];

  for (let number = config.min; number <= config.max; number += 1) {
    names.push(fieldNameFor(number));
  }

  return names;
}

export default {
  parseSelectedPropertyNumbers,
  buildSapPropertiesFlags,
  readSapPropertiesFlags,
  listSapPropertiesFieldNames,
};
