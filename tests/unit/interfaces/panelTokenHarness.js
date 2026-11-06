// App Fastify del panel con casos de uso reales sobre dobles en memoria, para las pruebas HTTP
// de tokens personales y registro de trabajo (contrato 12). No es un archivo de test.
import { jest } from '@jest/globals';
import Fastify from 'fastify';
import panelPlugin from '../../../src/interfaces/http/panel/panelPlugin.js';
import { buildPanelUseCases } from '../../../src/composition/panel.composition.js';
import HmacSessionToken from '../../../src/infrastructure/auth/HmacSessionToken.js';
import {
  FakeLoginAttempts,
  FakePasswordHasher,
  FakeRevokedSessions,
  FakeTenantDirectory,
  InMemoryPanelUserRepository,
  RecordingAuditLog,
  SequenceTemporaryPassword,
  TENANTS,
  clientUser,
  staffUser,
} from '../application/panel/panelFakes.js';
import {
  FakeApiTokenCodec,
  InMemoryApiTokenRepository,
  InMemoryIdempotencyStore,
} from '../application/panel/apiTokenFakes.js';
import {
  FakeAttachmentStore,
  FakeContextReader,
  InMemoryTicketRepository,
} from '../application/panel/ticketFakes.js';

export const SECRET = 'panel-api-tokens-test-secret-with-32-chars';
export const ACME = 'sap_integration_acme';
export const STAFF_PASSWORD = 'clave-del-staff';
export const PANEL = Object.freeze({ 'x-panel-request': '1' });

// ipLimit: con limitador de tokens inválidos por IP (como con proxies de confianza).
export async function buildTokenApp({ ipLimit = false, extraUsers = [] } = {}) {
  const dev = staffUser({ email: 'ana@smarteam.test', name: 'Ana Mora' });
  const otherDev = staffUser({ email: 'luis@smarteam.test', name: 'Luis Vargas', passwordHash: 'hash:clave-de-luis' });
  const admin = staffUser({ email: 'admin@smarteam.test', name: 'Admin Smarteam', passwordHash: 'hash:clave-admin' });
  const client = clientUser({ email: 'carla@acme.test', name: 'Carla Cliente' });
  const userRepository = new InMemoryPanelUserRepository([dev, otherDev, admin, client, ...extraUsers]);
  const tenantDirectory = new FakeTenantDirectory([...TENANTS]);
  const apiTokenRepository = new InMemoryApiTokenRepository();
  const apiTokenCodec = new FakeApiTokenCodec();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const ticketRepository = new InMemoryTicketRepository();
  const auditLog = new RecordingAuditLog();
  const passwordAttempts = new FakeLoginAttempts(5);
  const apiTokenAttempts = new FakeLoginAttempts(30);
  const invalidTokenIpAttempts = ipLimit ? new FakeLoginAttempts(20) : null;
  const sessionToken = new HmacSessionToken({ secret: SECRET });
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };

  const useCases = buildPanelUseCases({
    secret: SECRET,
    userRepository,
    tenantDirectory,
    passwordHasher: new FakePasswordHasher(),
    temporaryPasswordGenerator: new SequenceTemporaryPassword(),
    loginAttempts: new FakeLoginAttempts(),
    auditLog,
    revokedSessions: new FakeRevokedSessions(),
    sessionToken,
    ticketRepository,
    attachmentStore: new FakeAttachmentStore(),
    contextReader: new FakeContextReader(),
    tenantDbPrefix: 'sap_integration',
    logger,
    apiTokenRepository,
    apiTokenCodec,
    idempotencyStore,
    passwordAttempts,
    apiTokenAttempts,
    invalidTokenIpAttempts,
  });

  const app = Fastify();
  app.register(panelPlugin, { prefix: '/panel/api', secret: SECRET, useCases, logger });
  await app.ready();

  const cookieFor = (user) => `panel_session=${sessionToken.sign({ sub: user.id, tv: 0, pwdChange: false })}`;
  return {
    app,
    useCases,
    userRepository,
    tenantDirectory,
    apiTokenRepository,
    apiTokenCodec,
    idempotencyStore,
    ticketRepository,
    auditLog,
    passwordAttempts,
    apiTokenAttempts,
    invalidTokenIpAttempts,
    logger,
    users: { dev, otherDev, admin, client },
    cookies: { dev: cookieFor(dev), otherDev: cookieFor(otherDev), admin: cookieFor(admin), client: cookieFor(client) },
  };
}

// Pedido a /panel/api. json: cuerpo JSON. panelHeader: false para omitir X-Panel-Request.
export function send(app, { method = 'GET', url, cookie, bearer, authorization, json, payload, contentType, headers = {}, panelHeader = true }) {
  const options = { method, url: `/panel/api${url}`, headers: { ...headers } };
  if (cookie) {
    options.headers.cookie = cookie;
  }
  if (bearer) {
    options.headers.authorization = `Bearer ${bearer}`;
  }
  if (authorization !== undefined) {
    options.headers.authorization = authorization;
  }
  if (panelHeader && method !== 'GET') {
    options.headers['x-panel-request'] = '1';
  }
  if (json !== undefined) {
    options.payload = json;
  }
  if (payload !== undefined) {
    options.payload = payload;
  }
  if (contentType) {
    options.headers['content-type'] = contentType;
  }
  return app.inject(options);
}

// Token en claro creado por el caso de uso (como lo haría Mi cuenta).
export async function createToken(ctx, user = ctx.users.dev, password = STAFF_PASSWORD, name = 'Claude Code - laptop') {
  const result = await ctx.useCases.manageApiTokens.create({ user, fields: { name, currentPassword: password } });
  if (!result.ok) {
    throw new Error(`token not created: ${result.reason}`);
  }
  return result.data.token;
}

// Ticket de Acme abierto por el cliente con el número pedido; devuelve el registro guardado.
export async function openTicket(ctx, { number = 12, status = 'abierto', tenantKey = ACME } = {}) {
  ctx.ticketRepository.counters.set(tenantKey, number - 1);
  const result = await ctx.useCases.clientTickets.create({
    user: { ...ctx.users.client, tenantKey },
    fields: { title: 'La cotización no llegó', description: 'Detalle', category: 'documentos' },
    images: [],
  });
  if (!result.ok) {
    throw new Error(`ticket not created: ${result.reason}`);
  }
  const ticket = ctx.ticketRepository.tickets(tenantKey).find((candidate) => candidate.id === result.data.id);
  ticket.status = status;
  return ticket;
}

export function storedTicket(ctx, id, tenantKey = ACME) {
  return ctx.ticketRepository.tickets(tenantKey).find((candidate) => candidate.id === id);
}

export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function hasKeyDeep(value, key) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([name, nested]) => name === key || hasKeyDeep(nested, key));
}
