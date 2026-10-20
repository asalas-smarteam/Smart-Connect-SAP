import { readTicketForm } from '../panel/multipartImages.js';
import { jsonBody, sendAttachment, sendResult } from './panelTickets.controller.js';

const MESSAGE_FIELDS = ['body'];
const RESOLVE_FIELDS = ['message', 'internalResolution'];

function staffUser(req) {
  const { id, name, email, accountType } = req.panelUser;
  return { id, name, email, accountType };
}

// Bandeja y acciones de Smarteam. El :tenantKey de la ruta lo valida el caso de uso contra
// SaaSClients antes de abrir la base del tenant.
export function createPanelStaffTicketsController({ useCases }) {
  return {
    async inbox(req, reply) {
      return sendResult(reply, await useCases.staffInbox.list({ query: req.query ?? {} }));
    },

    async summary(req, reply) {
      return sendResult(reply, await useCases.staffInbox.summary());
    },

    async get(req, reply) {
      const { tenantKey, id } = req.params;
      return sendResult(reply, await useCases.staffTickets.get({ tenantKey, id }));
    },

    async reply(req, reply) {
      const { tenantKey, id } = req.params;
      const { fields, images } = await readTicketForm(req, MESSAGE_FIELDS);
      return sendResult(reply, await useCases.staffTickets.reply({ user: staffUser(req), tenantKey, id, fields, images }));
    },

    async setStatus(req, reply) {
      const { tenantKey, id } = req.params;
      return sendResult(reply, await useCases.staffTickets.setStatus({ user: staffUser(req), tenantKey, id, to: jsonBody(req).to }));
    },

    async resolve(req, reply) {
      const { tenantKey, id } = req.params;
      const { fields, images } = await readTicketForm(req, RESOLVE_FIELDS);
      return sendResult(reply, await useCases.staffTickets.resolve({ user: staffUser(req), tenantKey, id, fields, images }));
    },

    async setInternalResolution(req, reply) {
      const { tenantKey, id } = req.params;
      return sendResult(reply, await useCases.staffTickets.setInternalResolution({
        user: staffUser(req),
        tenantKey,
        id,
        text: jsonBody(req).text,
      }));
    },

    async attachment(req, reply) {
      const { tenantKey, id, fileId } = req.params;
      return sendAttachment(reply, await useCases.staffTickets.attachment({ tenantKey, id, fileId }));
    },
  };
}

export default createPanelStaffTicketsController;
