import { PANEL_PERMISSIONS } from '#domain/panel/permissions.js';
import { sendResult } from './panelTickets.controller.js';

// Eventos, syncs y tareas (contrato 03). El mismo handler sirve la ruta de cliente (tenant de
// la sesión) y la de staff (/staff/tenants/:tenantKey/..., validado por el caso de uso).
function scopeOf(req) {
  return { user: req.panelUser, routeTenantKey: req.params?.tenantKey };
}

// payload y audit: solo en la ruta de staff y con staff.events.raw. Nunca en rutas de cliente.
function canSeeRawEvents(req) {
  return req.params?.tenantKey !== undefined
    && req.panelUser?.accountType === 'smarteam'
    && (req.panelUser?.permissions ?? []).includes(PANEL_PERMISSIONS.STAFF_EVENTS_RAW);
}

export function createPanelOperationsController({ useCases }) {
  return {
    async listEvents(req, reply) {
      return sendResult(reply, await useCases.operations.listEvents({ scope: scopeOf(req), query: req.query ?? {} }));
    },

    async getEvent(req, reply) {
      return sendResult(reply, await useCases.operations.getEvent({
        scope: scopeOf(req),
        id: req.params.id,
        withRaw: canSeeRawEvents(req),
      }));
    },

    async listSyncs(req, reply) {
      return sendResult(reply, await useCases.operations.listSyncs({ scope: scopeOf(req), query: req.query ?? {} }));
    },

    async getSync(req, reply) {
      return sendResult(reply, await useCases.operations.getSync({ scope: scopeOf(req), id: req.params.id, query: req.query ?? {} }));
    },

    async dashboard(req, reply) {
      return sendResult(reply, await useCases.operations.dashboard({ scope: scopeOf(req), query: req.query ?? {} }));
    },

    async listTasks(req, reply) {
      return sendResult(reply, await useCases.operations.listTasks({ scope: scopeOf(req) }));
    },
  };
}

export default createPanelOperationsController;
