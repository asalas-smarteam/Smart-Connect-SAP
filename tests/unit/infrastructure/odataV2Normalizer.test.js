import {
  extractODataV2NextLink,
  normalizeODataV2Response,
  normalizeODataV2Scalar,
  normalizeODataV2Value,
  unwrapODataV2Envelope,
} from '../../../src/infrastructure/sap/transport/odataV2Normalizer.js';

describe('odataV2Normalizer', () => {
  describe('normalizeODataV2Scalar', () => {
    it('converts Edm.DateTime epoch strings to ISO-8601', () => {
      expect(normalizeODataV2Scalar('/Date(1659571200000)/')).toBe('2022-08-04T00:00:00.000Z');
    });

    it('converts Edm.DateTimeOffset without shifting the UTC instant', () => {
      expect(normalizeODataV2Scalar('/Date(1656633600000+0000)/')).toBe('2022-07-01T00:00:00.000Z');
      expect(normalizeODataV2Scalar('/Date(1656633600000-0500)/')).toBe('2022-07-01T00:00:00.000Z');
    });

    it('converts Edm.Time durations to HH:mm:ss', () => {
      expect(normalizeODataV2Scalar('PT20H40M35S')).toBe('20:40:35');
      expect(normalizeODataV2Scalar('PT7H7M2S')).toBe('07:07:02');
      expect(normalizeODataV2Scalar('PT5M')).toBe('00:05:00');
    });

    it('keeps the 9999-12-31 sentinel as a plain ISO date', () => {
      expect(normalizeODataV2Scalar('/Date(253402300799000+0000)/')).toBe('9999-12-31T23:59:59.000Z');
    });

    it('leaves regular strings, numbers and booleans untouched', () => {
      expect(normalizeODataV2Scalar('Oficina Local')).toBe('Oficina Local');
      expect(normalizeODataV2Scalar('PT')).toBe('PT');
      expect(normalizeODataV2Scalar(17)).toBe(17);
      expect(normalizeODataV2Scalar(false)).toBe(false);
      expect(normalizeODataV2Scalar(null)).toBe(null);
    });
  });

  describe('normalizeODataV2Value', () => {
    it('strips __metadata and drops deferred navigation properties', () => {
      const result = normalizeODataV2Value({
        __metadata: { uri: 'https://sap/A_BusinessPartner(\'10000\')' },
        BusinessPartner: '10000',
        to_Customer: {
          __deferred: { uri: 'https://sap/A_BusinessPartner(\'10000\')/to_Customer' },
        },
      });

      expect(result).toEqual({ BusinessPartner: '10000' });
    });

    it('flattens expanded navigation collections to arrays', () => {
      const result = normalizeODataV2Value({
        BusinessPartner: '10000',
        to_BusinessPartnerAddress: {
          results: [
            {
              __metadata: { uri: 'x' },
              AddressID: '23905',
              to_EmailAddress: {
                results: [
                  {
                    __metadata: { uri: 'y' },
                    IsDefaultEmailAddress: true,
                    EmailAddress: 'ATENCION.MQDO@MULTIQUIMICA.COM',
                  },
                ],
              },
            },
          ],
        },
      });

      expect(result).toEqual({
        BusinessPartner: '10000',
        to_BusinessPartnerAddress: [
          {
            AddressID: '23905',
            to_EmailAddress: [
              {
                IsDefaultEmailAddress: true,
                EmailAddress: 'ATENCION.MQDO@MULTIQUIMICA.COM',
              },
            ],
          },
        ],
      });
    });
  });

  describe('unwrapODataV2Envelope', () => {
    it('unwraps collection envelopes', () => {
      const data = { d: { results: [{ BusinessPartner: '10000' }] } };
      expect(unwrapODataV2Envelope(data)).toEqual([{ BusinessPartner: '10000' }]);
    });

    it('unwraps single-entity envelopes', () => {
      const data = { d: { BusinessPartner: '10000' } };
      expect(unwrapODataV2Envelope(data)).toEqual({ BusinessPartner: '10000' });
    });

    it('passes through payloads without the v2 envelope', () => {
      const data = { value: [{ CardCode: 'C1' }] };
      expect(unwrapODataV2Envelope(data)).toEqual(data);
    });
  });

  describe('extractODataV2NextLink', () => {
    it('returns the __next url when present', () => {
      const data = {
        d: {
          results: [],
          __next: 'https://sap:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$skiptoken=100',
        },
      };

      expect(extractODataV2NextLink(data)).toBe(
        'https://sap:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$skiptoken=100'
      );
    });

    it('returns null when there is no continuation', () => {
      expect(extractODataV2NextLink({ d: { results: [] } })).toBeNull();
      expect(extractODataV2NextLink(null)).toBeNull();
    });
  });

  describe('normalizeODataV2Response (end to end)', () => {
    it('normalizes a realistic A_BusinessPartner payload', () => {
      const payload = {
        d: {
          results: [
            {
              __metadata: { uri: 'https://sap/A_BusinessPartner(\'10000\')' },
              BusinessPartner: '10000',
              BusinessPartnerCategory: '1',
              BusinessPartnerFullName: 'Oficina Local',
              CreationDate: '/Date(1659571200000)/',
              CreationTime: 'PT20H40M35S',
              LastChangeDate: '/Date(1729036800000)/',
              OrganizationFoundationDate: null,
              to_BPCreditWorthiness: { __deferred: { uri: 'x' } },
              to_BusinessPartnerAddress: {
                results: [
                  {
                    __metadata: { uri: 'y' },
                    AddressID: '23905',
                    ValidityEndDate: '/Date(253402300799000+0000)/',
                    to_EmailAddress: {
                      results: [
                        {
                          __metadata: { uri: 'z' },
                          OrdinalNumber: '1',
                          IsDefaultEmailAddress: true,
                          EmailAddress: 'INFO@EXAMPLE.COM',
                        },
                      ],
                    },
                    to_PhoneNumber: { __deferred: { uri: 'w' } },
                  },
                ],
              },
            },
          ],
        },
      };

      expect(normalizeODataV2Response(payload)).toEqual([
        {
          BusinessPartner: '10000',
          BusinessPartnerCategory: '1',
          BusinessPartnerFullName: 'Oficina Local',
          CreationDate: '2022-08-04T00:00:00.000Z',
          CreationTime: '20:40:35',
          LastChangeDate: '2024-10-16T00:00:00.000Z',
          OrganizationFoundationDate: null,
          to_BusinessPartnerAddress: [
            {
              AddressID: '23905',
              ValidityEndDate: '9999-12-31T23:59:59.000Z',
              to_EmailAddress: [
                {
                  OrdinalNumber: '1',
                  IsDefaultEmailAddress: true,
                  EmailAddress: 'INFO@EXAMPLE.COM',
                },
              ],
            },
          ],
        },
      ]);
    });
  });
});
