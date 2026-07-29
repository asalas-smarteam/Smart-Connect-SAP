import { jest } from '@jest/globals';
import { S4ContactResolver } from '../../../src/infrastructure/sap/customers/S4ContactResolver.js';

function buildTransport({ relationships = [], persons = [] } = {}) {
  return {
    fetchAll: jest.fn(async ({ path }) => {
      if (path === '/API_BUSINESS_PARTNER/A_BusinessPartnerContact') return relationships;
      if (path === '/API_BUSINESS_PARTNER/A_BusinessPartner') return persons;
      return [];
    }),
  };
}

describe('S4ContactResolver', () => {
  it('requires a transport', () => {
    expect(() => new S4ContactResolver({})).toThrow('transport is required');
  });

  it('returns an empty map for no company ids', async () => {
    const resolver = new S4ContactResolver({ transport: buildTransport() });
    expect((await resolver.resolveContactsByCompany([])).size).toBe(0);
    expect((await resolver.resolveContactsByCompany(null)).size).toBe(0);
  });

  it('joins relationships to person-BPs and groups by company', async () => {
    const transport = buildTransport({
      relationships: [
        { BusinessPartnerCompany: '100051', BusinessPartnerPerson: '100000' },
        { BusinessPartnerCompany: '100051', BusinessPartnerPerson: '100001' },
        { BusinessPartnerCompany: '100052', BusinessPartnerPerson: '100002' },
        // a relationship for a company not requested -> ignored
        { BusinessPartnerCompany: '999999', BusinessPartnerPerson: '100003' },
      ],
      persons: [
        { BusinessPartner: '100000', FirstName: 'Oscar', LastName: 'Rosa' },
        { BusinessPartner: '100001', FirstName: 'Ana', LastName: 'Gil' },
        { BusinessPartner: '100002', FirstName: 'Luis', LastName: 'Paz' },
        { BusinessPartner: '100003', FirstName: 'No', LastName: 'Quiero' },
      ],
    });

    const resolver = new S4ContactResolver({ transport });
    const byCompany = await resolver.resolveContactsByCompany(['100051', '100052']);

    expect(byCompany.get('100051').map((p) => p.BusinessPartner)).toEqual(['100000', '100001']);
    expect(byCompany.get('100052').map((p) => p.BusinessPartner)).toEqual(['100002']);
    expect(byCompany.has('999999')).toBe(false);
  });

  it('filters relationships by BUR001 and drops incomplete rows', async () => {
    const transport = buildTransport({
      relationships: [
        { BusinessPartnerCompany: '100051', BusinessPartnerPerson: '100000' },
        { BusinessPartnerCompany: '100051', BusinessPartnerPerson: '' },
        { BusinessPartnerCompany: '', BusinessPartnerPerson: '100001' },
      ],
      persons: [{ BusinessPartner: '100000', FirstName: 'Oscar' }],
    });

    const resolver = new S4ContactResolver({ transport });
    const byCompany = await resolver.resolveContactsByCompany(['100051']);

    expect(byCompany.get('100051')).toHaveLength(1);
    // The BUR001 filter is applied server-side via $filter.
    const relCall = transport.fetchAll.mock.calls
      .find((c) => c[0].path === '/API_BUSINESS_PARTNER/A_BusinessPartnerContact');
    expect(decodeURIComponent(relCall[0].query.$filter)).toBe("RelationshipCategory eq 'BUR001'");
  });

  it('does not fetch persons when no relationship matches', async () => {
    const transport = buildTransport({
      relationships: [{ BusinessPartnerCompany: '777', BusinessPartnerPerson: '1' }],
      persons: [{ BusinessPartner: '1' }],
    });

    const resolver = new S4ContactResolver({ transport });
    const byCompany = await resolver.resolveContactsByCompany(['100051']);

    expect(byCompany.size).toBe(0);
    // Only the relationship fetch ran; the person fetch was skipped.
    expect(transport.fetchAll).toHaveBeenCalledTimes(1);
  });

  it('expands the person address navigations for email/phone', async () => {
    const transport = buildTransport({
      relationships: [{ BusinessPartnerCompany: '100051', BusinessPartnerPerson: '100000' }],
      persons: [{ BusinessPartner: '100000' }],
    });

    const resolver = new S4ContactResolver({ transport });
    await resolver.resolveContactsByCompany(['100051']);

    const personCall = transport.fetchAll.mock.calls
      .find((c) => c[0].path === '/API_BUSINESS_PARTNER/A_BusinessPartner');
    expect(personCall[0].query.$expand).toBe(
      'to_BusinessPartnerAddress/to_EmailAddress,to_BusinessPartnerAddress/to_PhoneNumber'
    );
    expect(decodeURIComponent(personCall[0].query.$filter)).toBe("BusinessPartnerCategory eq '1'");
  });
});
