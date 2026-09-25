// Cardinalidad de cada navegación de OData que este proyecto sabe escribir. Es una tabla
// EXPLÍCITA a propósito: el nombre no dice si la navegación es 1:1 o colección, y mandarla
// con la forma equivocada hace que el gateway rechace el POST completo, con un mensaje que
// no menciona el mapeo que lo causó. Una navegación que no esté acá se descarta.
export const S4_NAVIGATION_CARDINALITY = Object.freeze({
  to_BusinessPartnerAddress: 'collection',
  'to_BusinessPartnerAddress.to_EmailAddress': 'collection',
  'to_BusinessPartnerAddress.to_PhoneNumber': 'collection',
  to_BusinessPartnerRole: 'collection',
  // Colección, no 1:1: un socio de negocio tiene UNA FILA POR TIPO DE IMPUESTO, y por eso
  // quedarse con la primera es una decisión y no un detalle (el camino SAP -> HubSpot la
  // desempata explícitamente por BPTaxType, ver MappingFallbackConfigRepository). Es el camino
  // real de la cédula: `to_Customer.BPTaxLongNumber` NO existe en este servicio -- la entidad
  // de cliente solo ofrece TaxNumber1..TaxNumber5 -- y sin esta entrada un mapeo real de cédula
  // se descartaba con warn al crear el cliente.
  to_BusinessPartnerTax: 'collection',
  to_Customer: 'single',
  'to_Customer.to_CustomerCompany': 'collection',
  'to_Customer.to_CustomerSalesArea': 'collection',
  to_Item: 'collection',
  to_Partner: 'collection',
  to_PricingElement: 'collection',
});

// Devuelve el contenedor donde hay que escribir la hoja, creándolo si hace falta. En una
// colección siempre se usa el PRIMER elemento: dos mapeos hacia la misma dirección son dos
// campos de la misma fila, no dos filas a medio llenar.
function resolveContainer(root, navigationSegments) {
  let container = root;
  let path = '';

  for (const segment of navigationSegments) {
    path = path ? `${path}.${segment}` : segment;
    const cardinality = S4_NAVIGATION_CARDINALITY[path];

    if (!cardinality) {
      return { container: null, navigation: path };
    }

    if (cardinality === 'collection') {
      if (!Array.isArray(container[segment])) {
        container[segment] = [{}];
      }
      container = container[segment][0];
    } else {
      if (!container[segment] || typeof container[segment] !== 'object') {
        container[segment] = {};
      }
      container = container[segment];
    }
  }

  return { container, navigation: null };
}

// `{'to_Customer.BPTaxLongNumber': '3101'}` -> `{to_Customer: {BPTaxLongNumber: '3101'}}`.
// Las claves sin punto se copian tal cual, excepto si su nombre es una navegación conocida:
// eso es un mapeo mal configurado (un escalar dentro de una navegación), se descarta.
export function expandS4ODataKeys(flatFields, { logger = null } = {}) {
  const expanded = {};

  for (const [field, value] of Object.entries(flatFields || {})) {
    const segments = field.split('.');

    // Una clave plana cuyo nombre sea una navegación conocida es un mapeo inválido:
    // el gateway rechazaría enviar un escalar dentro de una navegación de OData. Se descarta
    // conservando las claves anidadas de esa navegación.
    if (segments.length === 1 && S4_NAVIGATION_CARDINALITY[field]) {
      logger?.warn?.({
        msg: 'Campo descartado: clave plana que nombra una navegación de OData',
        field,
        navigation: field,
      });
      continue;
    }

    if (segments.length === 1) {
      expanded[field] = value;
      continue;
    }

    const leaf = segments[segments.length - 1];
    const { container, navigation } = resolveContainer(expanded, segments.slice(0, -1));

    if (!container) {
      logger?.warn?.({
        msg: 'Campo descartado: navegación de OData desconocida, no se adivina su cardinalidad',
        field,
        navigation,
      });
      continue;
    }

    container[leaf] = value;
  }

  return expanded;
}

export default { S4_NAVIGATION_CARDINALITY, expandS4ODataKeys };
