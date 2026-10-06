// SAP keys that say "this HubSpot record already belongs to a SAP object".
// Contacts carry two: idsap (BusinessPartner) and internalcode (ContactEmployee).
// Companies only come from BusinessPartners.
export const SAP_OWNERSHIP_PROPERTIES = {
  contact: ['idsap', 'internalcode'],
  company: ['idsap'],
};

export function sapOwnershipPropertiesFor(objectType) {
  return SAP_OWNERSHIP_PROPERTIES[objectType] ?? ['idsap'];
}

function normalizeOwnershipValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Regla de búsqueda: primero la llave SAP (idsap / internalcode); solo si no
// existe se usa la segunda validación (defaultFindHubspot: phone, email...).
// Un registro hallado por esa segunda validación que ya trae OTRA llave SAP es
// de otro cliente de SAP: tomarlo como "existente" le pisaría el idsap y el
// nombre, y en la corrida siguiente el dueño real no se encontraría y se
// crearía de nuevo. Un lead sin llaves SAP sí se puede adoptar.
export function belongsToAnotherSapRecord(recordProperties, itemProperties, ownershipProperties = ['idsap']) {
  return ownershipProperties.some((name) => {
    const owner = normalizeOwnershipValue(recordProperties?.[name]);

    return owner !== '' && owner !== normalizeOwnershipValue(itemProperties?.[name]);
  });
}

export default {
  SAP_OWNERSHIP_PROPERTIES,
  sapOwnershipPropertiesFor,
  belongsToAnotherSapRecord,
};
