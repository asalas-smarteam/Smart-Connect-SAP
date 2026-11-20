import { sendResult } from './panelTickets.controller.js';

// Mapeo de responsables (contrato 13 lectura, contrato 14 edición). El mismo handler sirve la
// ruta de cliente (tenant de la sesión) y la de staff (/staff/tenants/:tenantKey/..., validado por
// el caso de uso).
export function createPanelOwnerMappingsController({ useCases }) {
  return {
    async list(req, reply) {
      const scope = { user: req.panelUser, routeTenantKey: req.params?.tenantKey };
      return sendResult(reply, await useCases.ownerMappings.list({ scope }));
    },

    // Contrato 14, O2: editar los códigos del ERP de una fila.
    async update(req, reply) {
      const scope = { user: req.panelUser, routeTenantKey: req.params?.tenantKey };
      return sendResult(reply, await useCases.ownerMappingsWrite.update({ scope, id: req.params?.id, body: req.body }));
    },

    // Contrato 14, O3: traer del CRM los responsables que faltan. Sin cuerpo.
    async sync(req, reply) {
      const scope = { user: req.panelUser, routeTenantKey: req.params?.tenantKey };
      return sendResult(reply, await useCases.ownerMappingsWrite.sync({ scope }));
    },
  };
}

export default createPanelOwnerMappingsController;
