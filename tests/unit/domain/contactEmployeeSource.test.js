import { resolveBusinessPartnerAndContactEmployees }
  from '../../../src/domain/business-partners/contact-employee-source.service.js';

const company = { hs_object_id: '1', name: 'ACME' };
const contact = { hs_object_id: '2', firstname: 'Juan' };
const employees = [{ hs_object_id: '3', firstname: 'Ana' }, { hs_object_id: '4', firstname: 'Luis' }];

describe('resolveBusinessPartnerAndContactEmployees — dealContact (conducta actual)', () => {
  const source = 'dealContact';

  it('company + contact: BP es la company y el contact es el CE', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company, contact, source });

    expect(result.businessPartnerSource).toBe('company');
    expect(result.businessPartner).toBe(company);
    expect(result.isCompanyBusinessPartner).toBe(true);
    expect(result.contactEmployeeSources).toEqual([contact]);
    // El write-back legacy de internalcode al contact del deal solo es correcto
    // en este caso: aqui ese contact SI es el ContactEmployee real.
    expect(result.dealContactIsContactEmployee).toBe(true);
  });

  it('solo contact: BP es el contact y no hay CE', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company: null, contact, source });

    expect(result.businessPartnerSource).toBe('contact');
    expect(result.isCompanyBusinessPartner).toBe(false);
    expect(result.contactEmployeeSources).toEqual([]);
    expect(result.dealContactIsContactEmployee).toBe(false);
  });

  it('solo company: BP es la company y no hay CE', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company, contact: null, source });

    expect(result.businessPartnerSource).toBe('company');
    expect(result.isCompanyBusinessPartner).toBe(true);
    expect(result.contactEmployeeSources).toEqual([]);
    expect(result.dealContactIsContactEmployee).toBe(false);
  });

  it('ignora payload.contactEmployees', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact, contactEmployees: employees, source,
    });

    expect(result.contactEmployeeSources).toEqual([contact]);
  });
});

describe('resolveBusinessPartnerAndContactEmployees — payloadArray (nuevo)', () => {
  const source = 'payloadArray';

  it('company + contact: BP es la company y los CE son el array; el contact del deal se ignora', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact, contactEmployees: employees, source,
    });

    expect(result.businessPartnerSource).toBe('company');
    expect(result.contactEmployeeSources).toEqual(employees);
    expect(result.contactEmployeeSources).not.toContain(contact);
    expect(result.warnings).toEqual([]);
    // Clave para el write-back: el contact del deal NO es ContactEmployee, asi
    // que nadie puede escribirle un internalCode de esta lista.
    expect(result.dealContactIsContactEmployee).toBe(false);
  });

  it('solo contact: BP es el contact y los CE son el array', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company: null, contact, contactEmployees: employees, source,
    });

    expect(result.businessPartnerSource).toBe('contact');
    expect(result.isCompanyBusinessPartner).toBe(false);
    expect(result.contactEmployeeSources).toEqual(employees);
  });

  it('solo company: BP es la company y los CE son el array', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact: null, contactEmployees: employees, source,
    });

    expect(result.contactEmployeeSources).toEqual(employees);
  });

  it('envuelve un objeto suelto en array', () => {
    const single = { hs_object_id: '9' };
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact: null, contactEmployees: single, source,
    });

    expect(result.contactEmployeeSources).toEqual([single]);
  });

  it('array ausente: CE vacio y warning, SIN caer al contact del deal', () => {
    const result = resolveBusinessPartnerAndContactEmployees({ company, contact, source });

    expect(result.contactEmployeeSources).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'BP_CONTACT_EMPLOYEES_ARRAY_MISSING' }]);
  });

  it('array vacio: CE vacio y warning', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact, contactEmployees: [], source,
    });

    expect(result.contactEmployeeSources).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'BP_CONTACT_EMPLOYEES_ARRAY_MISSING' }]);
  });

  it('descarta entradas que no son objetos', () => {
    const result = resolveBusinessPartnerAndContactEmployees({
      company, contact: null, contactEmployees: [null, 'texto', employees[0]], source,
    });

    expect(result.contactEmployeeSources).toEqual([employees[0]]);
  });
});

describe('resolveBusinessPartnerAndContactEmployees — validacion', () => {
  it.each(['dealContact', 'payloadArray'])('lanza si no hay company ni contact (%s)', (source) => {
    expect(() => resolveBusinessPartnerAndContactEmployees({ company: null, contact: null, source }))
      .toThrow(/company o un contact/);
  });
});
