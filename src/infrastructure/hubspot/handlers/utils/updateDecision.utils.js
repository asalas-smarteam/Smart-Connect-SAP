import HubspotUpdateFieldsConfigRepository from '#infrastructure/config/HubspotUpdateFieldsConfigRepository.js';

const hubspotUpdateFieldsConfigRepository = new HubspotUpdateFieldsConfigRepository();

function normalizeComparableValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function resolveSapIdentifier(properties = {}) {
  return normalizeComparableValue(
    properties?.idsap ?? properties?.idSap ?? properties?.internalcode
  );
}

function hasDifferentValue(currentValue, nextValue) {
  return normalizeComparableValue(currentValue) !== normalizeComparableValue(nextValue);
}

// El nombre de la config tiene que coincidir con el targetField del mapeo, y
// nadie garantiza que los dos estén escritos igual ('Phone' vs 'phone'). Se
// busca la clave real para poder mandarla a HubSpot tal como viene del mapeo.
function findPropertyKey(properties, field) {
  if (!properties || !field) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(properties, field)) {
    return field;
  }

  const wanted = String(field).trim().toLowerCase();

  return Object.keys(properties).find((key) => key.trim().toLowerCase() === wanted) ?? null;
}

function readProperty(properties, field) {
  const key = findPropertyKey(properties, field);

  return key ? properties[key] : undefined;
}

// Lista de campos configurados que traen algo que escribir. Un campo vacío en
// SAP se OMITE en vez de mandarse en blanco: borrar en HubSpot un dato que el
// asesor cargó a mano, porque en SAP nadie lo llenó, es pérdida de dato que no
// se detecta hasta que alguien busca el teléfono y no está.
function collectConfiguredEntries(properties = {}, updateFields = []) {
  const entries = [];

  for (const field of Array.isArray(updateFields) ? updateFields : []) {
    const key = findPropertyKey(properties, field);

    if (!key) {
      continue;
    }

    const value = properties[key];

    if (normalizeComparableValue(value) === null) {
      continue;
    }

    entries.push({ key, value });
  }

  return entries;
}

// Devuelve la lista de `hubspotUpdateFields` del tenant para un objectType.
//
// `updateFields` gana cuando el llamador ya la resolvió (los caminos batch la
// leen una vez por corrida y la bajan); si no viene, se lee acá. Nunca lanza:
// sin config la lista es vacía y el update vuelve a mandar solo identificadores.
export async function resolveHubspotUpdateFields({ tenantModels, objectType, updateFields }) {
  if (Array.isArray(updateFields)) {
    return updateFields;
  }

  return hubspotUpdateFieldsConfigRepository.getHubspotUpdateFields({ tenantModels, objectType });
}

export function shouldUpdateByKeyFields({
  existingProperties = {},
  incomingProperties = {},
  nameField,
  updateFields = [],
}) {
  const configuredChanged = collectConfiguredEntries(incomingProperties, updateFields)
    .some(({ key, value }) => hasDifferentValue(readProperty(existingProperties, key), value));

  return (
    configuredChanged
    || hasDifferentValue(existingProperties?.[nameField], incomingProperties?.[nameField])
    || hasDifferentValue(existingProperties?.phone, incomingProperties?.phone)
    || hasDifferentValue(
      resolveSapIdentifier(existingProperties),
      resolveSapIdentifier(incomingProperties)
    )
  );
}

export function buildIdentifierOnlyPayload(properties = {}) {
  const nextProperties = {};
  const idsap = normalizeComparableValue(properties?.idsap ?? properties?.idSap);
  const internalcode = normalizeComparableValue(properties?.internalcode);

  if (idsap) {
    nextProperties.idsap = idsap;
  }

  if (internalcode) {
    nextProperties.internalcode = internalcode;
  }

  return Object.keys(nextProperties).length > 0
    ? { properties: nextProperties }
    : null;
}

// Payload del PATCH: los identificadores de siempre MAS lo que el tenant haya
// nombrado en `hubspotUpdateFields`.
//
// Sin lista configurada es exactamente `buildIdentifierOnlyPayload`. Con lista,
// un registro sin `idsap` igual se actualiza: si no, la config no haría nada
// para todos los registros que aún no tienen el identificador escrito.
export function buildUpdatePayload(properties = {}, updateFields = []) {
  const identifiers = buildIdentifierOnlyPayload(properties);
  const nextProperties = { ...(identifiers?.properties ?? {}) };

  for (const { key, value } of collectConfiguredEntries(properties, updateFields)) {
    nextProperties[key] = value;
  }

  return Object.keys(nextProperties).length > 0
    ? { properties: nextProperties }
    : null;
}

export default {
  shouldUpdateByKeyFields,
  buildIdentifierOnlyPayload,
  buildUpdatePayload,
  resolveHubspotUpdateFields,
};
