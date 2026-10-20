import { createPort } from '../port-validator.js';

// Lectura (solo lectura) del evento o la corrida de sync que se enlaza a un ticket.
//   readEvent(tenantKey, id) → documento crudo del evento, sin payload completo ni auditoría, o null
//   readSync(tenantKey, id)  → { sync, task } crudos (sin la lista de errores ni credenciales), o null
// La traducción a nombres genéricos la hace el caso de uso con src/domain/panel/operationViews.js.
export const TicketContextReaderPort = createPort({
  name: 'TicketContextReaderPort',
  methods: [
    'readEvent',
    'readSync',
  ],
});
