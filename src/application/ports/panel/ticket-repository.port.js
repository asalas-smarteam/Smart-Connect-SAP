import { createPort } from '../port-validator.js';

// Tickets de soporte en la base de cada tenant. Todos los métodos reciben el tenantKey primero:
// el caso de uso decide de qué tenant se trata (sesión del cliente o empresa validada de staff).
//   newId()                                    id nuevo para un ticket o un mensaje
//   create(tenantKey, ticket, { codeFor })     asigna el correlativo y el código, y guarda
//   findById(tenantKey, id)                    ticket completo o null (id inválido → null)
//   list(tenantKey, { status, category, skip, limit })  { items (sin mensajes), total }
//   countByStatus(tenantKey)                   { abierto: n, ... }
//   update(tenantKey, id, change)              aplica el cambio si el estado sigue siendo
//                                              change.expectedStatus; si no, null
//   markSeen(tenantKey, id, side, at)          última vista del cliente o de Smarteam
//   listForMetrics(tenantKey, { window, category })  tickets sin mensajes para las métricas
export const TicketRepositoryPort = createPort({
  name: 'TicketRepositoryPort',
  methods: [
    'newId',
    'create',
    'findById',
    'list',
    'countByStatus',
    'update',
    'markSeen',
    'listForMetrics',
  ],
});
