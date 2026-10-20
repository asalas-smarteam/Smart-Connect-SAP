import { createPort } from '../port-validator.js';

// Próximas ejecuciones del programador para las tareas de un tenant (plan 7, J5). Solo lectura.
//   nextRunsFor(tenantKey) → Map<configId, Date>: la más cercana de cada tarea programada.
// Puede fallar o tardar (depende de Redis): quien llama no debe dejar que eso tumbe la respuesta.
export const ScheduledRunReaderPort = createPort({
  name: 'ScheduledRunReaderPort',
  methods: ['nextRunsFor'],
});
