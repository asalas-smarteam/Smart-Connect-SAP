import { mapB1BusinessPartnerToCustomer } from '#domain/sap/b1-customer.mapper.js';

const BUSINESS_PARTNERS_PATH = '/BusinessPartners';

// SapCustomerPort adapter for SAP Business One. Fetches raw records over the
// B1 transport and translates them into the flavor-agnostic customer entity.
export class B1CustomerAdapter {
  constructor({ transport }) {
    if (!transport) {
      throw new Error('transport is required for B1CustomerAdapter');
    }
    this.transport = transport;
  }

  async fetchCustomers({ query = {}, headers } = {}) {
    const records = await this.transport.fetchAll({
      path: BUSINESS_PARTNERS_PATH,
      query,
      headers,
    });

    return (Array.isArray(records) ? records : [])
      .map((record) => mapB1BusinessPartnerToCustomer(record))
      .filter(Boolean);
  }

  async fetchCustomerById(id) {
    const cardCode = String(id ?? '').trim();
    if (!cardCode) {
      return null;
    }

    try {
      const record = await this.transport.request({
        method: 'get',
        path: `${BUSINESS_PARTNERS_PATH}('${encodeURIComponent(cardCode)}')`,
      });

      return mapB1BusinessPartnerToCustomer(record);
    } catch (error) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}

export default B1CustomerAdapter;
