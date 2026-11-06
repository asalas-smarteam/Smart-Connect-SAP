import { sendFailure } from '../panel/panelErrors.js';
import { jsonBody, sendResult } from './panelTickets.controller.js';

// Tokens personales de Mi cuenta (contrato 12, M2). Solo con sesión de cookie, cuenta smarteam
// y staff.tickets: lo garantizan el guard (sin panelTokenAuth) y los preHandler de la ruta.
export function createPanelApiTokensController({ useCases }) {
  return {
    async list(req, reply) {
      return sendResult(reply, await useCases.manageApiTokens.list({ user: req.panelUser }));
    },

    // Body { name, currentPassword }. El token en claro sale solo en esta respuesta (201).
    async create(req, reply) {
      return sendResult(reply, await useCases.manageApiTokens.create({
        user: req.panelUser,
        fields: jsonBody(req),
        ip: req.panelClientIp ?? null,
      }));
    },

    // 204 sin cuerpo; id inválido, ajeno, inexistente o ya revocado → 404.
    async revoke(req, reply) {
      const result = await useCases.manageApiTokens.revoke({
        user: req.panelUser,
        id: req.params.id,
        ip: req.panelClientIp ?? null,
      });
      if (!result.ok) {
        return sendFailure(reply, result);
      }
      return reply.code(204).send();
    },
  };
}

export default createPanelApiTokensController;
