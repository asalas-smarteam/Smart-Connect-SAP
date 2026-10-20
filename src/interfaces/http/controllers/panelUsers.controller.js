import { sendFailure } from '../panel/panelErrors.js';

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function actorOf(req) {
  const { id, email, accountType } = req.panelUser;
  return { id, email, accountType };
}

function send(reply, result) {
  if (!result.ok) {
    return sendFailure(reply, result);
  }

  return reply.code(result.statusCode ?? 200).send(result.data);
}

// Gestión de usuarios y empresas por parte de Smarteam. Sin instancia a nivel de módulo.
export function createPanelUsersController({ useCases }) {
  return {
    async listUsers(req, reply) {
      const { tenantKey, page, pageSize } = req.query ?? {};
      return send(reply, await useCases.manageUsers.list({ tenantKey, page, pageSize }));
    },

    async createUser(req, reply) {
      const { email, name, accountType, tenantKey, role } = body(req);
      return send(reply, await useCases.manageUsers.create({
        actor: actorOf(req),
        ip: req.panelClientIp,
        email,
        name,
        accountType,
        tenantKey,
        role,
      }));
    },

    async updateUser(req, reply) {
      return send(reply, await useCases.manageUsers.update({
        actor: actorOf(req),
        ip: req.panelClientIp,
        id: req.params.id,
        patch: body(req),
      }));
    },

    async resetPassword(req, reply) {
      return send(reply, await useCases.manageUsers.resetPassword({
        actor: actorOf(req),
        ip: req.panelClientIp,
        id: req.params.id,
      }));
    },

    async listTenants(req, reply) {
      return send(reply, await useCases.listTenants.execute());
    },
  };
}

export default createPanelUsersController;
