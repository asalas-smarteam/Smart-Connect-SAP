import { createPort } from '../port-validator.js';

// Domain-level port for SAP customers (business partners). Adapters speak
// each flavor's entity model (B1 /BusinessPartners vs S/4 A_BusinessPartner)
// and return the flavor-agnostic entity from sap-customer.entity.js.
export const SapCustomerPort = createPort({
  name: 'SapCustomerPort',
  methods: [
    // fetchCustomers({ query, headers }) -> SapCustomer[]
    'fetchCustomers',
    // fetchCustomerById(id) -> SapCustomer | null
    'fetchCustomerById',
  ],
});

export default SapCustomerPort;
