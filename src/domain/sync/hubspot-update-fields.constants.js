// Qué propiedades de HubSpot se sobreescriben cuando el registro YA existe.
//
// Sin esta config, el update de company/contact manda UNICAMENTE `idsap` e
// `internalcode` (`buildIdentifierOnlyPayload`): el resto de lo mapeado se
// descarta antes de salir, así que un cambio de teléfono o de moneda en SAP
// nunca llegaba a HubSpot. Eso no es un bug suelto sino una postura: el asesor
// edita la ficha en HubSpot y pisarla en cada corrida le borra el trabajo.
//
// La config invierte quién decide: el tenant NOMBRA las propiedades que sí son
// del lado SAP y acepta que se pisen. Lo que no está en la lista se sigue sin
// tocar. Ausente o vacía = la conducta histórica, así que ningún tenant cambia
// hasta que la escriba.
export const HUBSPOT_UPDATE_FIELDS_CONFIG_KEY = 'hubspotUpdateFields';

// Se guarda por objectType porque las propiedades no se llaman igual en los dos
// lados (`name` en company, `firstname`/`lastname` en contact) y casi nunca se
// quiere pisar lo mismo en ambos.
export const HUBSPOT_UPDATE_FIELDS_OBJECT_TYPES = Object.freeze(['company', 'contact']);

export const DEFAULT_HUBSPOT_UPDATE_FIELDS = Object.freeze({
  company: Object.freeze([]),
  contact: Object.freeze([]),
});

// Los identificadores viajan SIEMPRE, estén o no en la lista: son la llave con
// la que el connector reencuentra el registro y no son dato editable del asesor.
export const HUBSPOT_IDENTIFIER_FIELDS = Object.freeze(['idsap', 'internalcode']);

function normalizeFieldList(value) {
  if (typeof value === 'string') {
    return normalizeFieldList([value]);
  }

  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  const seen = new Set();
  const fields = [];

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const field = entry.trim();
    // Se compara en minúsculas para no dejar entrar 'Phone' y 'phone' como dos
    // propiedades distintas, pero se CONSERVA la forma escrita: el nombre tiene
    // que coincidir con el targetField del mapeo, que puede tener mayúsculas.
    const key = field.toLowerCase();

    if (!field || seen.has(key)) {
      continue;
    }

    seen.add(key);
    fields.push(field);
  }

  return Object.freeze(fields);
}

// Devuelve la lista para un objectType; nunca lanza y nunca devuelve null.
//
// Acepta las dos formas: `{ company: [...], contact: [...] }` y un array suelto
// que aplica a todos los objectType, porque un tenant que quiere lo mismo en los
// dos lados escribe el array antes que repetirse.
export function resolveHubspotUpdateFieldsFor(rawValue, objectType) {
  if (Array.isArray(rawValue) || typeof rawValue === 'string') {
    return normalizeFieldList(rawValue);
  }

  if (!rawValue || typeof rawValue !== 'object' || !objectType) {
    return Object.freeze([]);
  }

  return normalizeFieldList(rawValue[objectType]);
}

export default {
  HUBSPOT_UPDATE_FIELDS_CONFIG_KEY,
  HUBSPOT_UPDATE_FIELDS_OBJECT_TYPES,
  DEFAULT_HUBSPOT_UPDATE_FIELDS,
  HUBSPOT_IDENTIFIER_FIELDS,
  resolveHubspotUpdateFieldsFor,
};
