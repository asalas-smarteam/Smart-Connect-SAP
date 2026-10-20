import { createPort } from '../port-validator.js';

// Lectura (solo lectura) de las tareas programadas (ClientConfigs) de un tenant ya validado (plan 7).
//   listScheduledTasks(tenantKey) → { items, truncated }: documentos crudos, solo los campos de la
//                                   vista, activas primero y por nombre.
// Si la consulta pasa su tiempo máximo, lanza PanelQueryTimeoutError.
export const ScheduledTaskReaderPort = createPort({
  name: 'ScheduledTaskReaderPort',
  methods: ['listScheduledTasks'],
});
