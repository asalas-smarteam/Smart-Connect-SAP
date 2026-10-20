import { createPort } from '../port-validator.js';

// Lectura (solo lectura) de los mapeos de campos en la base de un tenant ya validado (plan 6).
//   listFieldMappings(tenantKey) → { items, truncated }: documentos crudos, solo los campos de la
//                                  vista y ordenados por objectType, sourceContext y sourceField.
// Si la consulta pasa su tiempo máximo, lanza PanelQueryTimeoutError.
export const FieldMappingReaderPort = createPort({
  name: 'FieldMappingReaderPort',
  methods: ['listFieldMappings'],
});
