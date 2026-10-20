import { sendResult } from './panelTickets.controller.js';

// Métricas de soporte (contrato 05, F7 a F9). El cliente nunca recibe la tabla por empresa.
export function createPanelTicketMetricsController({ useCases }) {
  return {
    async forClient(req, reply) {
      return sendResult(reply, await useCases.ticketMetrics.forClient({ user: req.panelUser, query: req.query ?? {} }));
    },

    async forStaff(req, reply) {
      return sendResult(reply, await useCases.ticketMetrics.forStaff({ query: req.query ?? {} }));
    },
  };
}

export default createPanelTicketMetricsController;
