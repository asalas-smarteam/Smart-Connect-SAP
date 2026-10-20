import { createPort } from '../port-validator.js';

// Solo lectura de las empresas (tenants) para el panel: tenantKey, companyName y status.
export const TenantDirectoryPort = createPort({
  name: 'TenantDirectoryPort',
  methods: [
    'findByKey',
    'findManyByKeys',
    'listAll',
  ],
});
