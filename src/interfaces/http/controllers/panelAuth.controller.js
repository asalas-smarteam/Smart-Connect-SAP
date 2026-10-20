import { sendFailure } from '../panel/panelErrors.js';
import { SESSION_COOKIE_NAME, clearSessionCookie, setSessionCookie } from '../panel/panelSession.js';

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

// Sin instancia a nivel de módulo: el plugin del panel la crea solo si hay PANEL_JWT_SECRET.
export function createPanelAuthController({ useCases, cookie, logger }) {
  return {
    async login(req, reply) {
      const { email, password } = body(req);
      const result = await useCases.login.execute({
        email,
        password,
        clientIp: req.panelClientIp,
        clientIpKey: req.panelClientIpKey,
      });
      if (!result.ok) {
        return sendFailure(reply, result);
      }

      setSessionCookie(reply, result.data.token, cookie);
      return reply.code(200).send(result.data.session);
    },

    // Revoca esta sesión en el servidor y siempre responde 204: una sesión vencida o una
    // revocación fallida no dejan al usuario sin poder salir (la cookie se borra igual).
    async logout(req, reply) {
      const result = await useCases.logout.execute({
        token: req.cookies?.[SESSION_COOKIE_NAME],
        ip: req.panelClientIp,
      });

      if (result.data?.failed) {
        logger.error({ msg: 'Panel logout: session revocation failed', error: result.data.error });
      }

      clearSessionCookie(reply, cookie);
      return reply.code(204).send();
    },

    async me(req, reply) {
      const result = await useCases.getSession.execute({ userId: req.panelUser.id });
      if (!result.ok) {
        return sendFailure(reply, result);
      }

      return reply.code(200).send(result.data);
    },

    async changePassword(req, reply) {
      const { currentPassword, newPassword } = body(req);
      const result = await useCases.changePassword.execute({
        userId: req.panelUser.id,
        currentPassword,
        newPassword,
        ip: req.panelClientIp,
      });
      if (!result.ok) {
        return sendFailure(reply, result);
      }

      // Cookie nueva con el tokenVersion vigente (contrato C3).
      setSessionCookie(reply, result.data.token, cookie);
      return reply.code(204).send();
    },
  };
}

export default createPanelAuthController;
