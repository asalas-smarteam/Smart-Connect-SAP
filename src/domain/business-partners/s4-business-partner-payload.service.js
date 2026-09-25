// src/domain/business-partners/s4-business-partner-payload.service.js
import { expandS4ODataKeys } from '#domain/sap/s4-odata-payload.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';

// BusinessPartnerFullName es un campo CALCULADO de A_BusinessPartner: se puede leer pero no
// escribir. El tenant lo tiene mapeado porque es el que sirve para el sync SAP -> HubSpot;
// para crear hay que mandarlo en OrganizationBPName1.
const READ_ONLY_NAME_FIELD = 'BusinessPartnerFullName';
const WRITABLE_NAME_FIELD = 'OrganizationBPName1';

// Los tres campos que identifican el área de ventas donde se va a crear la oferta. Si alguno
// falta, `to_CustomerSalesArea[0]` queda con esa clave en `undefined`, y `JSON.stringify` la
// descarta en silencio: el POST sale sin decir nada y SAP lo rechaza recién en OData con
// "cliente no existe en el área de ventas" (o, peor, lo acepta en otra área distinta a la del
// documento). Fallar acá, antes de escribir nada en el maestro de clientes, evita ese hueco.
const SALES_AREA_FIELDS = [
  { key: 'salesOrganization', label: 'SalesOrganization' },
  { key: 'distributionChannel', label: 'DistributionChannel' },
  { key: 'division', label: 'Division' },
];

function hasEntries(value) {
  return Boolean(value) && Object.keys(value).length > 0;
}

function assertSalesAreaIsComplete(salesArea) {
  const missing = SALES_AREA_FIELDS.filter(
    ({ key }) => !toNonEmptyString(salesArea?.[key])
  ).map(({ label }) => label);

  if (missing.length === 0) {
    return;
  }

  const plural = missing.length > 1;
  throw new PermanentWebhookError(
    `El área de ventas es requerida para crear el cliente en S/4: falta${plural ? 'n' : ''} ${missing.join(', ')} en salesArea, que debe salir del mapeo deal/orders-quotations o de la configuración s4SalesDocument`
  );
}

export function buildS4BusinessPartnerCreatePayload({
  mappedCompany,
  creationConfig,
  salesArea,
  logger = null,
}) {
  assertSalesAreaIsComplete(salesArea);

  const defaults = creationConfig?.defaults ?? {};
  const expanded = expandS4ODataKeys(mappedCompany || {}, { logger });

  const { [READ_ONLY_NAME_FIELD]: readOnlyName, to_Customer: mappedCustomer, ...rest } = expanded;
  const name = toNonEmptyString(rest[WRITABLE_NAME_FIELD]) || toNonEmptyString(readOnlyName);

  if (!name) {
    throw new PermanentWebhookError(
      'El nombre de la empresa es requerido para crear el cliente en S/4: el mapeo company/businessPartner no produjo BusinessPartnerFullName ni OrganizationBPName1'
    );
  }

  // Precedencia: el mapeo llena, el default configurado pisa. Mismo orden que B1, donde el
  // default del tenant es la política y el dato de HubSpot es solo el relleno.
  const payload = {
    ...rest,
    ...defaults.BusinessPartner,
    [WRITABLE_NAME_FIELD]: name,
  };

  const roles = Array.isArray(defaults.BusinessPartnerRole) ? defaults.BusinessPartnerRole : [];
  if (roles.length > 0) {
    payload.to_BusinessPartnerRole = roles.map((role) => ({ BusinessPartnerRole: role }));
  }

  const customer = {
    ...(mappedCustomer && typeof mappedCustomer === 'object' ? mappedCustomer : {}),
    ...defaults.Customer,
  };

  if (hasEntries(defaults.CustomerCompany)) {
    customer.to_CustomerCompany = [{ ...defaults.CustomerCompany }];
  }

  // El área de ventas del DOCUMENTO gana sobre la de la config: el cliente tiene que quedar
  // registrado en el área donde se le va a crear la oferta, o SAP rechaza el documento con
  // "cliente no existe en el área de ventas".
  customer.to_CustomerSalesArea = [{
    ...defaults.CustomerSalesArea,
    SalesOrganization: salesArea?.salesOrganization,
    DistributionChannel: salesArea?.distributionChannel,
    Division: salesArea?.division,
  }];

  payload.to_Customer = customer;

  return payload;
}

export default { buildS4BusinessPartnerCreatePayload };
