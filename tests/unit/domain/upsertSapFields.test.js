import {
  valuesDiffer,
  buildBusinessPartnerUpdatePayload,
  buildContactEmployeeUpdatePayload,
} from '../../../src/domain/business-partners/upsert-sap-fields.service.js';

describe('valuesDiffer', () => {
  it('returns false when the HubSpot value is null, undefined or empty', () => {
    expect(valuesDiffer(null, 'anything')).toBe(false);
    expect(valuesDiffer(undefined, 'anything')).toBe(false);
    expect(valuesDiffer('', 'anything')).toBe(false);
    expect(valuesDiffer('   ', 'anything')).toBe(false);
  });

  it('trims strings before comparing', () => {
    expect(valuesDiffer(' Juan Perez ', 'Juan Perez')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(valuesDiffer('Juan Perez', 'JUAN PEREZ')).toBe(true);
  });

  it('compares numeric-looking values numerically', () => {
    expect(valuesDiffer(3, '3')).toBe(false);
    expect(valuesDiffer('3', 3)).toBe(false);
    expect(valuesDiffer('3.0', 3)).toBe(false);
    expect(valuesDiffer(4, 3)).toBe(true);
  });

  it('treats a missing SAP value as different when HubSpot has data', () => {
    expect(valuesDiffer('new@mail.com', undefined)).toBe(true);
    expect(valuesDiffer('new@mail.com', null)).toBe(true);
    expect(valuesDiffer('new@mail.com', '')).toBe(true);
  });
});

describe('buildBusinessPartnerUpdatePayload', () => {
  it('returns an empty object when nothing differs', () => {
    const payload = buildBusinessPartnerUpdatePayload({
      fields: ['EmailAddress', 'CardName'],
      mappedCompany: { EmailAddress: 'a@b.com', CardName: 'Acme' },
      mappedContact: {},
      sapBusinessPartner: { EmailAddress: 'a@b.com', CardName: 'Acme' },
    });

    expect(payload).toEqual({});
  });

  it('includes only the fields that differ', () => {
    const payload = buildBusinessPartnerUpdatePayload({
      fields: ['EmailAddress', 'CardName'],
      mappedCompany: { EmailAddress: 'new@b.com', CardName: 'Acme' },
      mappedContact: {},
      sapBusinessPartner: { EmailAddress: 'old@b.com', CardName: 'Acme' },
    });

    expect(payload).toEqual({ EmailAddress: 'new@b.com' });
  });

  it('ignores fields with no usable HubSpot value even if SAP has data', () => {
    const payload = buildBusinessPartnerUpdatePayload({
      fields: ['EmailAddress'],
      mappedCompany: { EmailAddress: '' },
      mappedContact: {},
      sapBusinessPartner: { EmailAddress: 'old@b.com' },
    });

    expect(payload).toEqual({});
  });

  it('prefers the company value over the contact value', () => {
    const payload = buildBusinessPartnerUpdatePayload({
      fields: ['EmailAddress'],
      mappedCompany: { EmailAddress: 'company@b.com' },
      mappedContact: { EmailAddress: 'contact@b.com' },
      sapBusinessPartner: { EmailAddress: 'old@b.com' },
    });

    expect(payload).toEqual({ EmailAddress: 'company@b.com' });
  });

  it('falls back to the contact value when the company has none', () => {
    const payload = buildBusinessPartnerUpdatePayload({
      fields: ['EmailAddress'],
      mappedCompany: {},
      mappedContact: { EmailAddress: 'contact@b.com' },
      sapBusinessPartner: { EmailAddress: 'old@b.com' },
    });

    expect(payload).toEqual({ EmailAddress: 'contact@b.com' });
  });

  it('returns an empty object when there are no fields configured', () => {
    const payload = buildBusinessPartnerUpdatePayload({
      fields: [],
      mappedCompany: { EmailAddress: 'new@b.com' },
      mappedContact: {},
      sapBusinessPartner: { EmailAddress: 'old@b.com' },
    });

    expect(payload).toEqual({});
  });
});

describe('buildContactEmployeeUpdatePayload', () => {
  it('returns an empty object when nothing differs', () => {
    const payload = buildContactEmployeeUpdatePayload({
      fields: ['Name', 'EmailAddress'],
      nextEmployee: { Name: 'Juan', E_Mail: 'juan@b.com' },
      existingEmployee: { Name: 'Juan', E_Mail: 'juan@b.com' },
    });

    expect(payload).toEqual({});
  });

  it('writes EmailAddress config field onto E_Mail (SAP has no EmailAddress on ContactEmployee)', () => {
    const payload = buildContactEmployeeUpdatePayload({
      fields: ['EmailAddress'],
      nextEmployee: { E_Mail: 'new@b.com' },
      existingEmployee: { E_Mail: 'old@b.com' },
    });

    expect(payload).toEqual({ E_Mail: 'new@b.com' });
    expect(payload).not.toHaveProperty('EmailAddress');
  });

  it('supports Name directly', () => {
    const payload = buildContactEmployeeUpdatePayload({
      fields: ['Name'],
      nextEmployee: { Name: 'Juan Nuevo' },
      existingEmployee: { Name: 'Juan Viejo' },
    });

    expect(payload).toEqual({ Name: 'Juan Nuevo' });
  });

  it('ignores fields with no usable value on nextEmployee', () => {
    const payload = buildContactEmployeeUpdatePayload({
      fields: ['Name'],
      nextEmployee: {},
      existingEmployee: { Name: 'Juan Viejo' },
    });

    expect(payload).toEqual({});
  });
});
