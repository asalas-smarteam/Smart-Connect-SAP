const BUSINESS_PARTNER_PATH = '/API_BUSINESS_PARTNER/A_BusinessPartner';
const CONTACT_RELATION_PATH = '/API_BUSINESS_PARTNER/A_BusinessPartnerContact';

// The person-BP holds the contact's real data; the relationship is just a
// pointer (verified: 0/123 relationships carry email/phone, 123/123 carry the
// person id). Email/phone live behind the person's address navigations.
const PERSON_EXPAND = [
  'to_BusinessPartnerAddress/to_EmailAddress',
  'to_BusinessPartnerAddress/to_PhoneNumber',
].join(',');

const enc = encodeURIComponent;

// Resolves S/4 contact persons for a set of company business partners.
// Strategy (verified against a live Gateway): the contact relationship entity
// is queryable top-level and there is NO expand from company to the person-BP,
// so we do two batched fetches + an in-memory join instead of N+1.
export class S4ContactResolver {
  constructor({ transport }) {
    if (!transport) {
      throw new Error('transport is required for S4ContactResolver');
    }
    this.transport = transport;
  }

  // Returns Map<companyBusinessPartner, personBP[]> restricted to companyIds.
  async resolveContactsByCompany(companyIds) {
    const wanted = new Set(
      (Array.isArray(companyIds) ? companyIds : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
    );

    if (wanted.size === 0) {
      return new Map();
    }

    const { personIdsByCompany, neededPersonIds } = await this.fetchRelationships(wanted);

    if (neededPersonIds.size === 0) {
      return new Map();
    }

    const personById = await this.fetchPersons(neededPersonIds);

    const result = new Map();
    for (const [company, personIds] of personIdsByCompany) {
      const persons = [...personIds]
        .map((id) => personById.get(id))
        .filter(Boolean);
      if (persons.length > 0) {
        result.set(company, persons);
      }
    }

    return result;
  }

  async fetchRelationships(wantedCompanies) {
    const relationships = await this.transport.fetchAll({
      path: CONTACT_RELATION_PATH,
      query: {
        $select: 'BusinessPartnerCompany,BusinessPartnerPerson',
        $filter: enc("RelationshipCategory eq 'BUR001'"),
      },
    });

    const personIdsByCompany = new Map();
    const neededPersonIds = new Set();

    for (const relation of Array.isArray(relationships) ? relationships : []) {
      const company = String(relation?.BusinessPartnerCompany ?? '').trim();
      const person = String(relation?.BusinessPartnerPerson ?? '').trim();

      if (!company || !person || !wantedCompanies.has(company)) {
        continue;
      }

      if (!personIdsByCompany.has(company)) {
        personIdsByCompany.set(company, new Set());
      }
      personIdsByCompany.get(company).add(person);
      neededPersonIds.add(person);
    }

    return { personIdsByCompany, neededPersonIds };
  }

  // Fetches all contact persons (category '1') with their address-dependent
  // email/phone, then keeps only the ones actually referenced. Category '1'
  // BPs are essentially all contacts, so a single filtered fetch is cheaper
  // and simpler than an id-by-id lookup (which would build huge OR URLs).
  async fetchPersons(neededPersonIds) {
    const persons = await this.transport.fetchAll({
      path: BUSINESS_PARTNER_PATH,
      query: {
        $filter: enc("BusinessPartnerCategory eq '1'"),
        $expand: PERSON_EXPAND,
      },
    });

    const personById = new Map();
    for (const person of Array.isArray(persons) ? persons : []) {
      const id = String(person?.BusinessPartner ?? '').trim();
      if (id && neededPersonIds.has(id)) {
        personById.set(id, person);
      }
    }

    return personById;
  }
}

export default S4ContactResolver;
