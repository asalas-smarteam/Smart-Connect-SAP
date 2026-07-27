import {
  SAP_CUSTOMER_KINDS,
  combineSapDateTime,
  createSapCustomer,
} from '../../../src/domain/sap/sap-customer.entity.js';
import { mapB1BusinessPartnerToCustomer } from '../../../src/domain/sap/b1-customer.mapper.js';
import { mapS4BusinessPartnerToCustomer } from '../../../src/domain/sap/s4-customer.mapper.js';

// A typical B1 Service Layer /BusinessPartners record.
const b1Record = {
  CardCode: 'C20000',
  CardName: 'Multiquimica Dominicana',
  CardType: 'C',
  CompanyPrivate: 'C',
  EmailAddress: 'ventas@multiquimica.do',
  Phone1: '809-555-0100',
  Phone2: '809-555-0101',
  PriceListNum: 2,
  FederalTaxID: 'J-101234567',
  UpdateDate: '2024-10-16T00:00:00Z',
  UpdateTime: '07:07:27',
};

// The S/4 A_BusinessPartner shape AFTER transport normalization (dates ISO,
// expansions flattened, __metadata/__deferred stripped) — mirrors the real
// payload captured from the client's QAS instance.
const s4Record = {
  BusinessPartner: '10000',
  Customer: '10000',
  BusinessPartnerCategory: '2',
  BusinessPartnerFullName: 'Multiquimica Dominicana',
  OrganizationBPName1: 'Multiquimica Dominicana SRL',
  LastChangeDate: '2024-10-16T00:00:00.000Z',
  LastChangeTime: '07:07:27',
  to_BusinessPartnerAddress: [
    {
      AddressID: '23905',
      to_EmailAddress: [
        {
          OrdinalNumber: '1',
          IsDefaultEmailAddress: true,
          EmailAddress: 'INFO=MULTIQUIMICA.COM@BF02.HUBSPOTFREE.NET',
        },
        {
          OrdinalNumber: '2',
          IsDefaultEmailAddress: false,
          EmailAddress: 'ATENCION.MQDO@MULTIQUIMICA.COM',
        },
      ],
      to_PhoneNumber: [
        {
          OrdinalNumber: '1',
          IsDefaultPhoneNumber: true,
          PhoneNumber: '809-555-0100',
        },
      ],
    },
  ],
};

describe('sap customer mappers (port contract)', () => {
  it('produces entities with the exact same shape for both flavors', () => {
    const fromB1 = mapB1BusinessPartnerToCustomer(b1Record);
    const fromS4 = mapS4BusinessPartnerToCustomer(s4Record);

    expect(Object.keys(fromB1).sort()).toEqual(Object.keys(fromS4).sort());
    expect(fromB1.emails[0]).toEqual(
      expect.objectContaining({ value: expect.any(String), isDefault: expect.any(Boolean) })
    );
    expect(fromS4.emails[0]).toEqual(
      expect.objectContaining({ value: expect.any(String), isDefault: expect.any(Boolean) })
    );
  });

  describe('B1 mapper', () => {
    it('maps a business partner into the domain entity', () => {
      const customer = mapB1BusinessPartnerToCustomer(b1Record);

      expect(customer).toEqual({
        idSap: 'C20000',
        kind: SAP_CUSTOMER_KINDS.ORGANIZATION,
        name: 'Multiquimica Dominicana',
        isCustomer: true,
        customerCode: 'C20000',
        priceListNum: 2,
        emails: [{ value: 'ventas@multiquimica.do', isDefault: true }],
        phones: [
          { value: '809-555-0100', isDefault: true },
          { value: '809-555-0101', isDefault: false },
        ],
        updatedAt: '2024-10-16T07:07:27',
        raw: b1Record,
      });
    });

    it('classifies private partners as persons, accepting both enum styles', () => {
      expect(
        mapB1BusinessPartnerToCustomer({ ...b1Record, CompanyPrivate: 'I' }).kind
      ).toBe(SAP_CUSTOMER_KINDS.PERSON);
      expect(
        mapB1BusinessPartnerToCustomer({ ...b1Record, CompanyPrivate: 'cPrivate' }).kind
      ).toBe(SAP_CUSTOMER_KINDS.PERSON);
      expect(
        mapB1BusinessPartnerToCustomer({ ...b1Record, CompanyPrivate: 'cCompany' }).kind
      ).toBe(SAP_CUSTOMER_KINDS.ORGANIZATION);
    });

    it('flags non-customers via CardType', () => {
      const supplier = mapB1BusinessPartnerToCustomer({ ...b1Record, CardType: 'S' });
      expect(supplier.isCustomer).toBe(false);

      const sdkStyle = mapB1BusinessPartnerToCustomer({ ...b1Record, CardType: 'cCustomer' });
      expect(sdkStyle.isCustomer).toBe(true);
    });

    it('omits empty contact data instead of emitting blanks', () => {
      const customer = mapB1BusinessPartnerToCustomer({
        CardCode: 'C1',
        CardName: 'X',
        EmailAddress: '  ',
        Phone1: null,
      });

      expect(customer.emails).toEqual([]);
      expect(customer.phones).toEqual([]);
    });

    it('returns null for non-object records', () => {
      expect(mapB1BusinessPartnerToCustomer(null)).toBeNull();
      expect(mapB1BusinessPartnerToCustomer('x')).toBeNull();
    });
  });

  describe('S4 mapper', () => {
    it('maps a business partner into the domain entity', () => {
      const customer = mapS4BusinessPartnerToCustomer(s4Record);

      expect(customer).toEqual({
        idSap: '10000',
        kind: SAP_CUSTOMER_KINDS.ORGANIZATION,
        name: 'Multiquimica Dominicana SRL',
        isCustomer: true,
        customerCode: '10000',
        priceListNum: null,
        emails: [
          { value: 'INFO=MULTIQUIMICA.COM@BF02.HUBSPOTFREE.NET', isDefault: true },
          { value: 'ATENCION.MQDO@MULTIQUIMICA.COM', isDefault: false },
        ],
        phones: [{ value: '809-555-0100', isDefault: true }],
        updatedAt: '2024-10-16T07:07:27',
        raw: s4Record,
      });
    });

    it('classifies category 1 as person and falls back to composed names', () => {
      const person = mapS4BusinessPartnerToCustomer({
        BusinessPartner: '10001',
        BusinessPartnerCategory: '1',
        BusinessPartnerFullName: '',
        FirstName: 'Oficina',
        LastName: 'Local',
      });

      expect(person.kind).toBe(SAP_CUSTOMER_KINDS.PERSON);
      expect(person.name).toBe('Oficina Local');
    });

    it('marks partners without a customer role as non-customers', () => {
      const notCustomer = mapS4BusinessPartnerToCustomer({
        BusinessPartner: '10002',
        BusinessPartnerCategory: '2',
        Customer: '',
      });

      expect(notCustomer.isCustomer).toBe(false);
      expect(notCustomer.customerCode).toBeNull();
    });

    it('deduplicates the same email across addresses, keeping the default flag', () => {
      const customer = mapS4BusinessPartnerToCustomer({
        BusinessPartner: '10003',
        BusinessPartnerCategory: '2',
        to_BusinessPartnerAddress: [
          {
            to_EmailAddress: [
              { EmailAddress: 'shared@example.com', IsDefaultEmailAddress: false },
            ],
          },
          {
            to_EmailAddress: [
              { EmailAddress: 'shared@example.com', IsDefaultEmailAddress: true },
            ],
          },
        ],
      });

      expect(customer.emails).toEqual([
        { value: 'shared@example.com', isDefault: true },
      ]);
    });

    it('handles records without expanded addresses', () => {
      const customer = mapS4BusinessPartnerToCustomer({
        BusinessPartner: '10004',
        BusinessPartnerCategory: '2',
      });

      expect(customer.emails).toEqual([]);
      expect(customer.phones).toEqual([]);
    });
  });

  describe('combineSapDateTime', () => {
    it('combines a date and an HH:mm:ss time into a naive timestamp', () => {
      expect(combineSapDateTime('2024-10-16T00:00:00.000Z', '07:07:27')).toBe('2024-10-16T07:07:27');
      expect(combineSapDateTime('2024-01-08', '13:40:00')).toBe('2024-01-08T13:40:00');
    });

    it('defaults the time to midnight and handles missing dates', () => {
      expect(combineSapDateTime('2024-01-08', null)).toBe('2024-01-08T00:00:00');
      expect(combineSapDateTime(null, '10:00:00')).toBeNull();
    });
  });

  describe('createSapCustomer', () => {
    it('requires idSap', () => {
      expect(() => createSapCustomer({})).toThrow('idSap is required');
    });

    it('normalizes unknown kinds and drops empty contact entries', () => {
      const customer = createSapCustomer({
        idSap: 'X1',
        kind: 'martian',
        emails: [{ value: '  ' }, { value: 'a@b.c', isDefault: true }],
      });

      expect(customer.kind).toBe(SAP_CUSTOMER_KINDS.UNKNOWN);
      expect(customer.emails).toEqual([{ value: 'a@b.c', isDefault: true }]);
    });
  });
});
