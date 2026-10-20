import { sendFailure } from '../panel/panelErrors.js';
import { readTicketForm } from '../panel/multipartImages.js';

const CREATE_FIELDS = ['title', 'description', 'category', 'contextType', 'contextId'];
const MESSAGE_FIELDS = ['body'];

export function jsonBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

export function sendResult(reply, result) {
  if (!result.ok) {
    return sendFailure(reply, result);
  }
  return reply.code(result.statusCode ?? 200).send(result.data);
}

// Imagen de un ticket (contrato D10): tipo detectado al subirla, inline y sin sniffing.
export function sendAttachment(reply, result) {
  if (!result.ok) {
    return sendFailure(reply, result);
  }
  const file = result.data;
  reply
    .header('Content-Type', file.contentType)
    .header('Content-Disposition', 'inline')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private')
    // Si alguien abre la imagen como documento, no puede ejecutar nada ni cargarse desde otro sitio.
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .header('Cross-Origin-Resource-Policy', 'same-origin');
  if (Number.isFinite(file.size)) {
    reply.header('Content-Length', String(file.size));
  }
  return reply.send(file.stream);
}

// Tickets de una cuenta cliente. El tenant sale de req.panelUser (la sesión) dentro del caso
// de uso: ninguna ruta lee tenantKey de la URL, la query, el body ni los headers.
export function createPanelTicketsController({ useCases }) {
  return {
    async list(req, reply) {
      return sendResult(reply, await useCases.clientTickets.list({ user: req.panelUser, query: req.query ?? {} }));
    },

    async create(req, reply) {
      const { fields, images } = await readTicketForm(req, CREATE_FIELDS);
      return sendResult(reply, await useCases.clientTickets.create({ user: req.panelUser, fields, images }));
    },

    async get(req, reply) {
      return sendResult(reply, await useCases.clientTickets.get({ user: req.panelUser, id: req.params.id }));
    },

    async reply(req, reply) {
      const { fields, images } = await readTicketForm(req, MESSAGE_FIELDS);
      return sendResult(reply, await useCases.clientTickets.reply({ user: req.panelUser, id: req.params.id, fields, images }));
    },

    async reopen(req, reply) {
      return sendResult(reply, await useCases.clientTickets.reopen({
        user: req.panelUser,
        id: req.params.id,
        message: jsonBody(req).message,
      }));
    },

    async attachment(req, reply) {
      return sendAttachment(reply, await useCases.clientTickets.attachment({
        user: req.panelUser,
        id: req.params.id,
        fileId: req.params.fileId,
      }));
    },
  };
}

export default createPanelTicketsController;
