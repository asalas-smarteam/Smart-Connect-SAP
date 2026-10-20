import { createPort } from '../port-validator.js';

// record(entry) nunca lanza: la auditoría es best effort y no hace fallar la acción.
export const PanelAuditLogPort = createPort({
  name: 'PanelAuditLogPort',
  methods: [
    'record',
  ],
});
