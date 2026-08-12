// SAP B1 devuelve los ContactEmployees como colección anidada del
// BusinessPartner, pero solo si el campo está en el $select. Hoy solo entra por
// la variable de entorno COMPANY_ADD_FIELDS_URL_SAP, cuyo mapa es
// { company, product, deal } (serviceLayerUrlBuilder.js:43-47): NO existe la
// equivalente para 'contact', así que en la tarea de contactos el campo nunca
// llega. Este mapping sintético lo arregla por tenant en vez de por despliegue.
//
// Mismo molde que withDynamicDescriptionSelectFields
// (src/domain/sync/dynamic-description.service.js:288-315): entradas con
// targetField null que solo sirven para armar el request a SAP y nunca escriben
// propiedades de HubSpot. No contaminan el mapeo porque mapRecords vuelve a
// consultar los mappings desde Mongo por su cuenta.
const CONTACT_EMPLOYEES_FIELD = 'ContactEmployees';

// Load-bearing: sanitizeSelectFields (serviceLayerUrlBuilder.js:21-41) excluye
// del $select todo mapping con sourceContext 'contactEmployee'. Un sintético con
// ese contexto se filtraría a sí mismo, y el síntoma sería invisible: $select sin
// el campo, SAP sin la colección, array vacío, cero errores.
const SYNTHETIC_SOURCE_CONTEXT = 'businessPartner';

function cleanString(value) {
  return String(value ?? '').trim();
}

export function withContactEmployeesSelectField(mappings, { objectType, sourceContext } = {}) {
  const baseMappings = Array.isArray(mappings) ? mappings : [];

  // Para 'company' el campo ya llega por la variable de entorno que los tenants
  // existentes tienen configurada. Solo la tarea de contactos lo necesita.
  if (objectType !== 'contact') {
    return Array.isArray(mappings) ? mappings : baseMappings;
  }

  const alreadySelected = baseMappings
    .filter((mapping) => mapping?.includeInServiceLayerSelect !== false)
    .some((mapping) => cleanString(mapping?.sourceField) === CONTACT_EMPLOYEES_FIELD);

  if (alreadySelected) {
    return mappings;
  }

  return [
    ...baseMappings,
    {
      sourceField: CONTACT_EMPLOYEES_FIELD,
      targetField: null,
      objectType: objectType ?? null,
      sourceContext: sourceContext ?? SYNTHETIC_SOURCE_CONTEXT,
      includeInServiceLayerSelect: true,
      isActive: true,
    },
  ];
}

export default { withContactEmployeesSelectField };
