import { createPort } from '../port-validator.js';

// Reads the raw rows that back a dropdown: a master-data collection
// (/BusinessPartnerGroups, /SalesPersons, /Currencies), a user table, or the
// UDF metadata in /UserFieldsMD. Turning rows into options is the domain's job.
export const SapDropdownCatalogPort = createPort({
  name: 'SapDropdownCatalogPort',
  methods: [
    // fetchRows({ tenantContext, serviceLayerPath, query }) -> array of rows
    'fetchRows',
  ],
});

export default SapDropdownCatalogPort;
