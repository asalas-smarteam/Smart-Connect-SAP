import { buildCompanyContactPayload } from '../../../src/application/services/companyContactPayload.service.js';

describe('buildCompanyContactPayload', () => {
  const fallbackEmailGenerator = (companyEmail, code) => (code ? `bp-${code}@fallback.local` : null);

  it('prefers the SAP contact email (B1 E_Mail)', () => {
    const { contactPayload, sapInternalCode } = buildCompanyContactPayload({
      mappedContact: { properties: { firstname: 'Ana', email: 'mapped@x.com' } },
      sapContact: { InternalCode: 7, E_Mail: ' ana@sap.com ' },
      companyFallbackSourceEmail: 'company@x.com',
      fallbackEmailGenerator,
    });

    expect(contactPayload.properties.email).toBe('ana@sap.com');
    expect(sapInternalCode).toBe(7);
  });

  it('uses the S/4 BusinessPartner id and EmailAddress field', () => {
    const { contactPayload, sapInternalCode } = buildCompanyContactPayload({
      mappedContact: { properties: { firstname: 'Luis' } },
      sapContact: { BusinessPartner: 'BP-9', EmailAddress: 'luis@s4.com' },
      companyFallbackSourceEmail: null,
      fallbackEmailGenerator,
    });

    expect(contactPayload.properties.email).toBe('luis@s4.com');
    expect(sapInternalCode).toBe('BP-9');
  });

  it('falls back to the generated email when no email exists', () => {
    const { contactPayload } = buildCompanyContactPayload({
      mappedContact: { properties: { firstname: 'Eva' } },
      sapContact: { InternalCode: 3 },
      companyFallbackSourceEmail: 'company@x.com',
      fallbackEmailGenerator,
    });

    expect(contactPayload.properties.email).toBe('bp-3@fallback.local');
  });

  it('does not mutate the mapped contact', () => {
    const mappedContact = { properties: { firstname: 'Eva' } };
    buildCompanyContactPayload({
      mappedContact,
      sapContact: { InternalCode: 3, E_Mail: 'e@x.com' },
      companyFallbackSourceEmail: null,
      fallbackEmailGenerator,
    });
    expect(mappedContact.properties.email).toBeUndefined();
  });
});
