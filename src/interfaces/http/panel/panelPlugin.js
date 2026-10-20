import cookie from '@fastify/cookie';
import panelConfig from '#infrastructure/config/panel.config.js';
import defaultLogger from '#infrastructure/logger/logger.adapter.js';
import { buildPanelUseCases } from '#composition/panel.composition.js';
import { PANEL_PERMISSIONS } from '#domain/panel/permissions.js';
import { createPanelAuthController } from '../controllers/panelAuth.controller.js';
import { createPanelUsersController } from '../controllers/panelUsers.controller.js';
import { createPanelTicketsController } from '../controllers/panelTickets.controller.js';
import { createPanelStaffTicketsController } from '../controllers/panelStaffTickets.controller.js';
import { createPanelOperationsController } from '../controllers/panelOperations.controller.js';
import { createPanelTicketMetricsController } from '../controllers/panelTicketMetrics.controller.js';
import { createPanelFieldMappingsController } from '../controllers/panelFieldMappings.controller.js';
import { registerPanelMultipart } from './multipartImages.js';
import { registerPanelErrorHandlers } from './panelErrors.js';
import { createTrustedProxyMatcher } from './clientIp.js';
import {
  createPanelRequestGuard,
  requireAnyPermission,
  requireClientAccount,
  requirePermission,
  requireStaffAccount,
} from './panelSession.js';

const JSON_CONTENT_TYPE = 'application/json';

// Motivo por el que el secreto no sirve, o null si sirve. Igual a JWT_SECRET sería grave: con
// la llave de los webhooks se podrían firmar sesiones de Smarteam.
function secretProblem(secret, tenantJwtSecret) {
  if (!secret) {
    return 'PANEL_JWT_SECRET not set';
  }
  if (secret.length < panelConfig.minSecretLength) {
    return `PANEL_JWT_SECRET must have at least ${panelConfig.minSecretLength} characters`;
  }
  if (tenantJwtSecret && secret === tenantJwtSecret) {
    return 'PANEL_JWT_SECRET must differ from JWT_SECRET';
  }
  return null;
}

// Parser JSON propio del panel, solo dentro de este plugin. El de src/main/app.js responde 500
// ante un JSON inválido y falla con un body vacío; aquí el vacío es {} y lo inválido (o con
// __proto__ / constructor) es un 400. El resto de la API sigue con su parser.
function registerPanelJsonParser(app) {
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');

  app.removeContentTypeParser(JSON_CONTENT_TYPE);
  app.addContentTypeParser(JSON_CONTENT_TYPE, { parseAs: 'string' }, (req, rawBody, done) => {
    if (rawBody === '' || rawBody == null) {
      done(null, {});
      return;
    }

    defaultJsonParser(req, rawBody, done);
  });
}

// /panel/api: API del panel de soporte (smartHubPanel). Se registra con prefijo y encapsulada:
// su parser, su cookie, sus hooks y sus errores no tocan ninguna otra ruta.
export default async function panelPlugin(app, options = {}) {
  const {
    secret = panelConfig.jwtSecret,
    tenantJwtSecret = panelConfig.tenantJwtSecret,
    cookieSecure = true,
    logger = defaultLogger,
    trustedProxies = panelConfig.trustedProxies,
  } = options;

  const problem = secretProblem(secret, tenantJwtSecret);
  if (problem) {
    logger.warn({ msg: `Panel API disabled: ${problem}` });
    return;
  }

  const proxyMatcher = createTrustedProxyMatcher(trustedProxies);
  if (proxyMatcher.invalidEntries.length > 0) {
    logger.warn({ msg: 'Panel API: invalid PANEL_TRUSTED_PROXIES entries ignored', entries: proxyMatcher.invalidEntries });
  }
  if (!proxyMatcher.enabled) {
    logger.warn({ msg: 'Panel API: per-IP login limit disabled (PANEL_TRUSTED_PROXIES not set)' });
  }

  const useCases = options.useCases ?? buildPanelUseCases({ secret, ipLimitEnabled: proxyMatcher.enabled });
  const cookieSettings = {
    cookiePath: panelConfig.cookiePath,
    cookieSecure,
    sessionTtlSeconds: panelConfig.sessionTtlSeconds,
  };

  registerPanelJsonParser(app);
  await app.register(cookie);
  await registerPanelMultipart(app);

  // no-store en todo /panel/api, salvo las imágenes de tickets, que ya fijan 'private'.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
  app.addHook('onRequest', createPanelRequestGuard({
    resolveSession: useCases.resolveSession,
    cookie: cookieSettings,
    proxyMatcher,
  }));

  registerPanelErrorHandlers(app, { logger });

  const auth = createPanelAuthController({ useCases, cookie: cookieSettings, logger });
  const users = createPanelUsersController({ useCases });
  const tickets = createPanelTicketsController({ useCases });
  const staffTickets = createPanelStaffTicketsController({ useCases });
  const operations = createPanelOperationsController({ useCases });
  const ticketMetrics = createPanelTicketMetricsController({ useCases });
  const fieldMappings = createPanelFieldMappingsController({ useCases });
  const P = PANEL_PERMISSIONS;

  app.route({
    method: 'POST',
    url: '/auth/login',
    config: { panelPublic: true },
    handler: auth.login,
  });

  app.route({
    method: 'POST',
    url: '/auth/logout',
    config: { panelPublic: true, allowPendingPasswordChange: true },
    handler: auth.logout,
  });

  app.route({
    method: 'GET',
    url: '/auth/me',
    config: { allowPendingPasswordChange: true },
    handler: auth.me,
  });

  app.route({
    method: 'POST',
    url: '/auth/change-password',
    config: { allowPendingPasswordChange: true },
    handler: auth.changePassword,
  });

  app.route({
    method: 'GET',
    url: '/staff/users',
    preHandler: requirePermission(P.STAFF_USERS),
    handler: users.listUsers,
  });

  app.route({
    method: 'POST',
    url: '/staff/users',
    preHandler: requirePermission(P.STAFF_USERS),
    handler: users.createUser,
  });

  app.route({
    method: 'PATCH',
    url: '/staff/users/:id',
    preHandler: requirePermission(P.STAFF_USERS),
    handler: users.updateUser,
  });

  app.route({
    method: 'POST',
    url: '/staff/users/:id/reset-password',
    preHandler: requirePermission(P.STAFF_USERS),
    handler: users.resetPassword,
  });

  // Lo usan Usuarios, la Bandeja y Eventos/Syncs: basta cualquiera de los permisos de staff.
  app.route({
    method: 'GET',
    url: '/staff/tenants',
    preHandler: requireAnyPermission([P.STAFF_USERS, P.STAFF_TICKETS, P.STAFF_EVENTS_RAW]),
    handler: users.listTenants,
  });

  // Soporte del cliente (contrato D1, D3 a D7, D10). El tenant sale de la sesión.
  app.route({
    method: 'GET',
    url: '/tickets',
    preHandler: requirePermission(P.TICKETS_READ),
    handler: tickets.list,
  });

  app.route({
    method: 'POST',
    url: '/tickets',
    preHandler: requirePermission(P.TICKETS_CREATE),
    handler: tickets.create,
  });

  app.route({
    method: 'GET',
    url: '/tickets/:id',
    preHandler: requirePermission(P.TICKETS_READ),
    handler: tickets.get,
  });

  app.route({
    method: 'POST',
    url: '/tickets/:id/messages',
    preHandler: requirePermission(P.TICKETS_REPLY),
    handler: tickets.reply,
  });

  app.route({
    method: 'POST',
    url: '/tickets/:id/reopen',
    preHandler: requirePermission(P.TICKETS_REOPEN),
    handler: tickets.reopen,
  });

  app.route({
    method: 'GET',
    url: '/tickets/:id/attachments/:fileId',
    preHandler: requirePermission(P.TICKETS_READ),
    handler: tickets.attachment,
  });

  // Bandeja y acciones de Smarteam (contrato D2, D3, D8, D10).
  app.route({
    method: 'GET',
    url: '/staff/tickets',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.inbox,
  });

  app.route({
    method: 'GET',
    url: '/staff/tickets/summary',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.summary,
  });

  app.route({
    method: 'GET',
    url: '/staff/tenants/:tenantKey/tickets/:id',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.get,
  });

  app.route({
    method: 'POST',
    url: '/staff/tenants/:tenantKey/tickets/:id/messages',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.reply,
  });

  app.route({
    method: 'POST',
    url: '/staff/tenants/:tenantKey/tickets/:id/status',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.setStatus,
  });

  app.route({
    method: 'POST',
    url: '/staff/tenants/:tenantKey/tickets/:id/resolve',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.resolve,
  });

  app.route({
    method: 'PUT',
    url: '/staff/tenants/:tenantKey/tickets/:id/internal-resolution',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.setInternalResolution,
  });

  app.route({
    method: 'GET',
    url: '/staff/tenants/:tenantKey/tickets/:id/attachments/:fileId',
    preHandler: requirePermission(P.STAFF_TICKETS),
    handler: staffTickets.attachment,
  });

  // Eventos, syncs y tareas (contrato 03). Solo lectura. Rutas de cliente con el tenant de la
  // sesión; rutas de staff por empresa, solo para cuentas de Smarteam.
  const OPERATION_ROUTES = [
    ['/events', P.EVENTS_READ, operations.listEvents],
    ['/events/:id', P.EVENTS_READ, operations.getEvent],
    ['/syncs', P.SYNCS_READ, operations.listSyncs],
    ['/syncs/:id', P.SYNCS_READ, operations.getSync],
    ['/sync-tasks', P.SYNCS_READ, operations.listTasks],
    // Contrato 05, F1 a F6: resumen de integración del Inicio.
    ['/dashboard/integration', P.EVENTS_READ, operations.dashboard],
  ];
  for (const [path, permission, handler] of OPERATION_ROUTES) {
    app.route({
      method: 'GET',
      url: path,
      preHandler: [requireClientAccount, requirePermission(permission)],
      handler,
    });
    app.route({
      method: 'GET',
      url: `/staff/tenants/:tenantKey${path}`,
      preHandler: [requireStaffAccount, requirePermission(permission)],
      handler,
    });
  }

  // Contrato 05, F7 a F9: métricas de soporte. Rutas estáticas: Fastify las prefiere a
  // /tickets/:id, así que "metrics" nunca se toma como un id de ticket.
  app.route({
    method: 'GET',
    url: '/tickets/metrics',
    preHandler: [requireClientAccount, requirePermission(P.TICKETS_READ)],
    handler: ticketMetrics.forClient,
  });

  app.route({
    method: 'GET',
    url: '/staff/tickets/metrics',
    preHandler: [requireStaffAccount, requirePermission(P.STAFF_TICKETS)],
    handler: ticketMetrics.forStaff,
  });

  // Plan 6 (contrato 08, I1): mapeo de campos, solo lectura. Cliente con el tenant de la sesión;
  // Smarteam por empresa.
  app.route({
    method: 'GET',
    url: '/field-mappings',
    preHandler: [requireClientAccount, requirePermission(P.MAPPINGS_READ)],
    handler: fieldMappings.list,
  });

  app.route({
    method: 'GET',
    url: '/staff/tenants/:tenantKey/field-mappings',
    preHandler: [requireStaffAccount, requirePermission(P.MAPPINGS_READ)],
    handler: fieldMappings.list,
  });
}
