import { sendResult } from './panelTickets.controller.js';

// Mapeo de responsables (contrato 13). El mismo handler sirve la ruta de cliente (tenant de la
// sesión) y la de staff (/staff/tenants/:tenantKey/..., validado por el caso de uso).
export function createPanelOwnerMappingsController({ useCases }) {
  return {
    async list(req, reply) {
      const scope = { user: req.panelUser, routeTenantKey: req.params?.tenantKey };
      return sendResult(reply, await useCases.ownerMappings.list({ scope }));
    },
  };
}

export default createPanelOwnerMappingsController;
