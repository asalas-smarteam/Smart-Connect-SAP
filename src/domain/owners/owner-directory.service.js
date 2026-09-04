// Homologación de USUARIOS de SAP hacia HubSpot.
//
// Una propiedad "de usuario" de HubSpot (type enumeration + referencedObjectType
// OWNER: `hubspot_owner_id` y cualquier propietario custom del portal, por
// ejemplo `propietario_del_contacto_resma_tmk`) solo acepta el ownerId de ESE
// portal. SAP guarda su propio código de empleado de ventas
// (SalesPersonCode = 600), así que copiar el valor tal cual hace que HubSpot
// rechace el registro COMPLETO con 400 -- no solo esa propiedad -- y con él se
// pierden nombre, email y todo lo demás del sync.
//
// La tabla de equivalencia es la colección OwnerMappings del tenant. Se carga
// UNA vez por corrida y se consulta en memoria: el tenant printer tiene 91
// owners y traducir con una query por registro convertiría un sync de 5.000
// empresas en 5.000 lecturas extra a Mongo.
//
// UNA SOLA DIRECCIÓN: SAP -> HubSpot (tareas programadas). La dirección inversa
// (webhooks que crean BusinessPartners o documentos con el ownerId de HubSpot)
// queda FUERA por decisión explícita, y el formato de `sapOwnerId` explica por
// qué es la decisión correcta: con '100,200,300' no hay un código único que
// escribir en SAP, y elegir uno por nuestra cuenta sería inventar la sucursal.
// El camino que hoy resuelve SlpCode en los webhooks (resolveDocumentSlpCode)
// sigue intacto y valida con Number.isInteger, así que un valor CSV le sale
// null con un warn en vez de llegar a SAP.
//
// Qué mapeo es de usuario lo declara el propio FieldMapping con `userField:
// true`. NO se deduce del nombre del campo de SAP a propósito: en un mismo
// tenant `SalesPersonCode` viaja a `propietario_del_contacto_resma_tmk` (que es
// de usuario y necesita el ownerId) y a `slpcode` (un número suelto que debe
// llegar tal cual). Una lista por nombre de campo no puede distinguirlos.

export function isOwnerFieldMapping(mapping) {
  return mapping?.userField === true;
}

// Las dos puntas se normalizan a string: SAP entrega SalesPersonCode como
// número (600) y OwnerMappings lo guarda como texto ('600'), así que sin esto
// la búsqueda falla por tipo y el valor se iría sin traducir.
function toDirectoryKey(value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  const key = String(value).trim();
  return key === '' ? null : key;
}

// `sapOwnerId` es texto y admite VARIOS códigos separados por coma:
// '100,200,300'. En B1 la misma persona tiene un SalesPersonCode por sucursal o
// departamento ('CENTMK - Teresa Barahona' = 113, 'QUITMK - Teresa Barahona' =
// 758, 'JUTTMK - ...' = 864), así que la relación real es N códigos de SAP -> 1
// owner de HubSpot.
//
// No se modela con una fila por código porque el índice
// uniq_hubspot_owner_mapping admite un solo documento por hubspotOwnerId, y
// romperlo dejaría a listOwnerMappings y al seed de HubSpot devolviendo la
// misma persona repetida. Un solo código ('600') es el mismo formato con una
// sola entrada, así que no hay dos casos que mantener.
export function parseSapOwnerIds(value) {
  return String(value ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

// La primera fila gana ante un duplicado. El índice parcial
// uniq_sap_owner_mapping_partial es sobre la cadena COMPLETA, así que no impide
// que un mismo código aparezca dentro del CSV de dos personas distintas:
// elegir en silencio es mejor que reventar el sync entero por una carga a mano.
export function createOwnerDirectory(ownerMappings) {
  const sapToHubspot = new Map();

  for (const mapping of Array.isArray(ownerMappings) ? ownerMappings : []) {
    if (mapping?.active === false) {
      continue;
    }

    const hubspotOwnerId = toDirectoryKey(mapping?.hubspotOwnerId);

    if (!hubspotOwnerId) {
      continue;
    }

    for (const sapOwnerId of parseSapOwnerIds(mapping?.sapOwnerId)) {
      if (!sapToHubspot.has(sapOwnerId)) {
        sapToHubspot.set(sapOwnerId, hubspotOwnerId);
      }
    }
  }

  return { sapToHubspot, size: sapToHubspot.size };
}

export function resolveHubspotOwnerId(directory, sapOwnerId) {
  const key = toDirectoryKey(sapOwnerId);
  return key ? (directory?.sapToHubspot?.get(key) ?? null) : null;
}

// Estados de una traducción SAP -> HubSpot:
//
// - 'passthrough': el campo de SAP viene vacío. Se deja pasar tal cual para NO
//   cambiar la conducta histórica: un '' en una propiedad de propietario limpia
//   el dueño en HubSpot, y eso es lo que hace hoy cualquier campo mapeado.
// - 'resolved': hay equivalencia; viaja el ownerId de HubSpot.
// - 'unresolved': el código de SAP no está homologado. La clave se OMITE (no se
//   manda null) para que el registro siga sincronizándose y el propietario que
//   alguien haya puesto a mano en HubSpot no se borre por una tabla incompleta.
//   Este es el caso de códigos de SAP que no son personas, como el 600 =
//   'INHABILITADO TMK' del tenant printer: no tienen owner en HubSpot y nunca
//   van a tenerlo.
export function translateSapOwnerValue({ value, directory }) {
  const key = toDirectoryKey(value);

  if (!key) {
    return { status: 'passthrough', value };
  }

  const hubspotOwnerId = resolveHubspotOwnerId(directory, key);

  return hubspotOwnerId
    ? { status: 'resolved', value: hubspotOwnerId }
    : { status: 'unresolved', value: null };
}

export default {
  createOwnerDirectory,
  isOwnerFieldMapping,
  parseSapOwnerIds,
  resolveHubspotOwnerId,
  translateSapOwnerValue,
};
