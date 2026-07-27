import { mapS4BusinessPartnerToCustomer } from '#domain/sap/s4-customer.mapper.js';

const BUSINESS_PARTNER_PATH = '/API_BUSINESS_PARTNER/A_BusinessPartner';

// Email/phone live under address navigation in S/4 (they arrive as
// __deferred stubs unless expanded), and to_Customer carries the customer
// role data (tax numbers, sales-relevant fields) in the same request.
const DEFAULT_EXPAND = [
  'to_BusinessPartnerAddress/to_EmailAddress',
  'to_BusinessPartnerAddress/to_PhoneNumber',
  'to_Customer',
].join(',');

// SapCustomerPort adapter for SAP S/4HANA Gateway. Fetches A_BusinessPartner
// records (with contact expansions) and translates them into the
// flavor-agnostic customer entity.
export class S4CustomerAdapter {
  constructor({ transport }) {
    if (!transport) {
      throw new Error('transport is required for S4CustomerAdapter');
    }
    this.transport = transport;
  }

  buildQuery(query = {}) {
    // Caller-provided options win; the expand default only applies when the
    // caller did not decide otherwise.
    return {
      $expand: DEFAULT_EXPAND,
      ...query,
    };
  }

  async fetchCustomers({ query = {}, headers } = {}) {
    const records = await this.transport.fetchAll({
      path: BUSINESS_PARTNER_PATH,
      query: this.buildQuery(query),
      headers,
    });

    return (Array.isArray(records) ? records : [])
      .map((record) => mapS4BusinessPartnerToCustomer(record))
      .filter(Boolean);
  }

  async fetchCustomerById(id) {
    const businessPartner = String(id ?? '').trim();
    if (!businessPartner) {
      return null;
    }

    try {
      const record = await this.transport.request({
        method: 'get',
        path: `${BUSINESS_PARTNER_PATH}('${encodeURIComponent(businessPartner)}')`,
        query: { $expand: DEFAULT_EXPAND },
      });

      return mapS4BusinessPartnerToCustomer(record);
    } catch (error) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}

export default S4CustomerAdapter;
