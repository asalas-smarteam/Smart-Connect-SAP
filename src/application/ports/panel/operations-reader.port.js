import { createPort } from '../port-validator.js';

// Lectura (solo lectura) de eventos, corridas de sync y tareas en la base de un tenant ya
// validado. Devuelve documentos crudos; la traducción a nombres genéricos la hace el caso de uso.
//   listEvents(tenantKey, { filters, skip, limit })      → { items, total }
//   findEvent(tenantKey, id, { withRaw })                 → evento o null
//   listSyncs(tenantKey, { filters, skip, limit })        → { items, total } (sin errores)
//   findSync(tenantKey, id, { errorsSkip, errorsLimit })  → { sync, errorsTotal } o null
//   findTasks(tenantKey, ids)                             → tareas (solo clientName y taskType)
//   listTasks(tenantKey)                                  → todas las tareas, por nombre
//   listEventsForSummary(tenantKey, { from, to, limit })  → { items, truncated } (resumen F2)
//   findQueueEventIds(tenantKey, { references, from, to }) → [{ id, reference }] eventos con error
//                                                            de esos negocios en la ventana (plan 5b)
// Si una consulta pasa su tiempo máximo, lanza PanelQueryTimeoutError.
export const OperationsReaderPort = createPort({
  name: 'OperationsReaderPort',
  methods: [
    'listEvents',
    'findEvent',
    'listSyncs',
    'findSync',
    'findTasks',
    'listTasks',
    'listEventsForSummary',
    'findQueueEventIds',
  ],
});
