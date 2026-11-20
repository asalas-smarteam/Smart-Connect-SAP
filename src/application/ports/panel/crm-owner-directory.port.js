import { createPort } from '../port-validator.js';

// Responsables del CRM de un tenant ya validado (plan 12, contrato 14, O3).
//   listCredentials(tenantKey) → [{ id }]: credenciales del CRM del tenant.
//   fetchOwners(tenantKey, credentialId) → [{ hubspotOwnerId, hubspotOwnerName,
//     hubspotOwnerEmail }]: todos (paginado), con el token renovado si venció. Si el CRM no
//     responde o el token no se puede renovar, lanza.
export const CrmOwnerDirectoryPort = createPort({
  name: 'CrmOwnerDirectoryPort',
  methods: ['listCredentials', 'fetchOwners'],
});
