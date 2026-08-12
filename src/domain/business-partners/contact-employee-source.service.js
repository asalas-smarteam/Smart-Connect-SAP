import { PermanentWebhookError } from '#shared/errors/index.js';
import { CONTACT_EMPLOYEE_SOURCES } from './business-partner-creation.constants.js';

export const CONTACT_EMPLOYEE_WARNINGS = Object.freeze({
  ARRAY_MISSING: 'BP_CONTACT_EMPLOYEES_ARRAY_MISSING',
});

// El workflow puede mandar un objeto suelto en vez de un array; envolverlo
// cuesta dos líneas y evita una clase entera de errores de configuración.
function toObjectList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object');
  }

  return value && typeof value === 'object' ? [value] : [];
}

export function resolveBusinessPartnerAndContactEmployees({
  company,
  contact,
  contactEmployees,
  source,
}) {
  const companyExists = Boolean(company);
  const contactExists = Boolean(contact);

  if (!companyExists && !contactExists) {
    throw new PermanentWebhookError(
      'El deal debe tener una company o un contact asociado para resolver el BusinessPartner'
    );
  }

  // El BP es la company si viene; si no, el contact. La regla es la misma en
  // ambas strategies: lo único que cambia es de dónde salen los CE.
  const businessPartnerSource = companyExists ? 'company' : 'contact';
  const warnings = [];
  let contactEmployeeSources = [];
  // Solo en modo dealContact el contact del deal ES el (único) ContactEmployee
  // real. Con payloadArray los CE salen de payload.contactEmployees y el contact
  // del deal explícitamente NO es uno de ellos, así que cualquier write-back que
  // le estampe un InternalCode (la vía legacy de updateAfterSap y del snapshot
  // en WebhookEvent) tiene que ir condicionado a esta bandera: si no, escribe el
  // código SAP de otra persona en un registro de HubSpot que no le corresponde.
  let dealContactIsContactEmployee = false;

  if (source === CONTACT_EMPLOYEE_SOURCES.PAYLOAD_ARRAY) {
    contactEmployeeSources = toObjectList(contactEmployees);

    if (contactEmployeeSources.length === 0) {
      // A propósito NO se cae al contact del deal: hacerlo reproduciría, de
      // forma invisible, la conducta que este modo existe para cambiar.
      warnings.push({ code: CONTACT_EMPLOYEE_WARNINGS.ARRAY_MISSING });
    }
  } else if (companyExists && contactExists) {
    contactEmployeeSources = [contact];
    dealContactIsContactEmployee = true;
  }

  return {
    businessPartnerSource,
    businessPartner: companyExists ? company : contact,
    // Equivale exactamente a la expresión `companyExists || !contactExists`
    // que los use-cases pasaban como `companyExists` al adapter.
    isCompanyBusinessPartner: businessPartnerSource === 'company',
    contactEmployeeSources,
    dealContactIsContactEmployee,
    warnings,
  };
}

export default { resolveBusinessPartnerAndContactEmployees, CONTACT_EMPLOYEE_WARNINGS };
