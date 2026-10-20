import { sendResult } from './panelTickets.controller.js';

// Tareas programadas (contrato 09). El mismo handler sirve la ruta de cliente (tenant de la
// sesión) y la de staff (/staff/tenants/:tenantKey/..., validado por el caso de uso).
export function createPanelScheduledTasksController({ useCases }) {
  return {
    async list(req, reply) {
      const scope = { user: req.panelUser, routeTenantKey: req.params?.tenantKey };
      return sendResult(reply, await useCases.scheduledTasks.list({ scope }));
    },
  };
}

export default createPanelScheduledTasksController;
