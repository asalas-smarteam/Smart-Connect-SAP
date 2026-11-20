import { createPort } from '../port-validator.js';

// Lectura (solo lectura) de los mapeos de responsables (OwnerMappings) de un tenant ya validado
// (plan 11).
//   listOwnerMappings(tenantKey) → { items, truncated }: documentos crudos, solo los campos de la
//                                  vista (sin hubspotCredentialId).
// Si la consulta pasa su tiempo máximo, lanza PanelQueryTimeoutError.
export const OwnerMappingReaderPort = createPort({
  name: 'OwnerMappingReaderPort',
  methods: ['listOwnerMappings'],
});
