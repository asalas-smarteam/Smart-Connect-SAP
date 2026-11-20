import { createPort } from '../port-validator.js';

// Escritura del mapeo de responsables (OwnerMappings) de un tenant ya validado, solo para el
// panel (plan 12, contrato 14). No reemplaza la API admin /mappings/owners.
//   findById(tenantKey, id) → documento crudo o null (id inválido → null sin consultar).
//   updateErpCodes(tenantKey, id, { expectedUpdatedAt, set }) → documento nuevo, o null si la
//     fila ya no tiene ese updatedAt (o no existe). Si el índice único del vendedor lo rechaza,
//     lanza un error con code 'ERP_OWNER_TAKEN'.
//   listByCredential(tenantKey, credentialId) → [{ _id, hubspotOwnerId, hubspotOwnerName,
//     hubspotOwnerEmail }].
//   insertSeeded(tenantKey, { hubspotCredentialId, hubspotOwnerId, hubspotOwnerName,
//     hubspotOwnerEmail }) → documento insertado (igual que el seed) o null si ya existía.
//   refreshCrmOwnerData(tenantKey, id, { hubspotOwnerName, hubspotOwnerEmail }) → sin mover
//     updatedAt.
//   countAll(tenantKey) → número de filas.
//   appendHistory(tenantKey, entry) → inserta un documento en OwnerMappingHistory.
export const OwnerMappingWriterPort = createPort({
  name: 'OwnerMappingWriterPort',
  methods: [
    'findById',
    'updateErpCodes',
    'listByCredential',
    'insertSeeded',
    'refreshCrmOwnerData',
    'countAll',
    'appendHistory',
  ],
});
