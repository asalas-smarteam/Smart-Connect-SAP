import {
  buildWebhookEventReferenceUpdates,
  resolveDealContactEmployeeCode,
} from '../../../src/application/services/webhook-payload.service.js';
import { resolveBusinessPartnerAndContactEmployees }
  from '../../../src/domain/business-partners/contact-employee-source.service.js';

// Los internalCodes que devuelve addContactEmployeesIfNeeded: un par
// { contact, internalCode } por cada ContactEmployee real que se creo en SAP.
const dealContact = { hs_object_id: 'contact-deal', firstname: 'Juan' };
const company = { hs_object_id: 'company-1', name: 'ACME' };
const payloadEmployees = [
  { hs_object_id: 'contact-ana', firstname: 'Ana' },
  { hs_object_id: 'contact-luis', firstname: 'Luis' },
];

function resolveShape(source, contactEmployees) {
  return resolveBusinessPartnerAndContactEmployees({
    company,
    contact: dealContact,
    contactEmployees,
    source,
  });
}

describe('resolveDealContactEmployeeCode', () => {
  // GUARDIA DE NO-REGRESION: con la config por defecto (dealContact) el contact
  // del deal ES el ContactEmployee real, y su internalcode debe seguir viajando
  // por la via legacy de updateAfterSap exactamente como antes del fix.
  it('devuelve el codigo del contact del deal en modo dealContact', () => {
    const shape = resolveShape('dealContact');

    expect(resolveDealContactEmployeeCode({
      dealContactIsContactEmployee: shape.dealContactIsContactEmployee,
      internalCodes: [{ contact: dealContact, internalCode: 501 }],
    })).toBe(501);
  });

  // EL BUG: internalCodes[0] es de OTRO contacto (Ana). Escribirselo al contact
  // del deal le mete el codigo SAP de un tercero en HubSpot, y ademas pisa la
  // escritura correcta que updateContactEmployeeCodes acaba de hacer.
  it('no devuelve nada en modo payloadArray, donde el contact del deal no es ContactEmployee', () => {
    const shape = resolveShape('payloadArray', payloadEmployees);

    expect(resolveDealContactEmployeeCode({
      dealContactIsContactEmployee: shape.dealContactIsContactEmployee,
      internalCodes: [
        { contact: payloadEmployees[0], internalCode: 601 },
        { contact: payloadEmployees[1], internalCode: 602 },
      ],
    })).toBeUndefined();
  });

  it('devuelve undefined cuando no hay internalCodes aunque el modo sea dealContact', () => {
    expect(resolveDealContactEmployeeCode({
      dealContactIsContactEmployee: true,
      internalCodes: [],
    })).toBeUndefined();
    expect(resolveDealContactEmployeeCode({
      dealContactIsContactEmployee: true,
      internalCodes: undefined,
    })).toBeUndefined();
  });
});

describe('buildWebhookEventReferenceUpdates — internalCode del snapshot', () => {
  function buildPayload() {
    return { company: { ...company }, contact: { ...dealContact } };
  }

  it('escribe internalCode al contact del deal en modo dealContact', () => {
    const payload = buildPayload();
    const shape = resolveShape('dealContact');

    const updates = buildWebhookEventReferenceUpdates({
      payload,
      companyExists: true,
      contactExists: true,
      contactEmployeeCode: 501,
      dealContactIsContactEmployee: shape.dealContactIsContactEmployee,
    });

    expect(updates).toEqual({ 'payload.contact.internalCode': '501' });
    expect(payload.contact.internalCode).toBe('501');
  });

  it('NO escribe internalCode al contact del deal en modo payloadArray', () => {
    const payload = buildPayload();
    const shape = resolveShape('payloadArray', payloadEmployees);

    const updates = buildWebhookEventReferenceUpdates({
      payload,
      companyExists: true,
      contactExists: true,
      contactEmployeeCode: 601,
      dealContactIsContactEmployee: shape.dealContactIsContactEmployee,
    });

    expect(updates).toEqual({});
    expect(payload.contact).not.toHaveProperty('internalCode');
  });

  it('falla cerrado: sin la bandera no escribe internalCode', () => {
    const payload = buildPayload();

    const updates = buildWebhookEventReferenceUpdates({
      payload,
      companyExists: true,
      contactExists: true,
      contactEmployeeCode: 601,
    });

    expect(updates).toEqual({});
  });

  // El fix no toca la rama de idsap: sigue escribiendo el CardCode al objeto que
  // ES el BusinessPartner, sin importar de donde salgan los ContactEmployees.
  it('sigue escribiendo idsap a la company aunque el modo sea payloadArray', () => {
    const payload = buildPayload();

    const updates = buildWebhookEventReferenceUpdates({
      payload,
      companyExists: true,
      contactExists: true,
      cardCode: 'CL00129',
      dealContactIsContactEmployee: false,
    });

    expect(updates).toEqual({ 'payload.company.idsap': 'CL00129' });
    expect(payload.company.idsap).toBe('CL00129');
  });

  it('escribe idsap al contact cuando el BP es el contact (sin company)', () => {
    const payload = { contact: { ...dealContact } };

    const updates = buildWebhookEventReferenceUpdates({
      payload,
      companyExists: false,
      contactExists: true,
      cardCode: 'CL00130',
      dealContactIsContactEmployee: false,
    });

    expect(updates).toEqual({ 'payload.contact.idsap': 'CL00130' });
  });
});
