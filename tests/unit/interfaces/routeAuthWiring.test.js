import { jest } from '@jest/globals';
import Fastify from 'fastify';

// Cableado de autenticación por ruta. Los controllers son falsos: lo que se prueba es qué
// preHandler protege cada ruta, que es donde vivía el hueco (rutas admin alcanzables con solo
// un x-tenant-id, y rutas sin ninguna protección).
const INTERNAL_KEY = 'test-internal-key';
process.env.INTERNAL_KEY = INTERNAL_KEY;

const mockTenantResolver = jest.fn(async (req) => {
  req.tenantKey = 'resolved-by-webhook-resolver';
});
const mockAdminTenantResolver = jest.fn(async (req) => {
  req.tenantKey = 'resolved-by-admin-resolver';
});

jest.unstable_mockModule('../../../src/interfaces/http/middlewares/tenantResolver.js', () => ({
  tenantResolver: mockTenantResolver,
  adminTenantResolver: mockAdminTenantResolver,
}));

function handler() {
  return jest.fn(async (req, reply) => reply.send({ ok: true, tenantKey: req.tenantKey ?? null }));
}

function handlers(names) {
  return Object.fromEntries(names.map((name) => [name, handler()]));
}

const CONTROLLERS = '../../../src/interfaces/http/controllers';

jest.unstable_mockModule(`${CONTROLLERS}/config.controller.js`, () => handlers([
  'createClientConfig',
  'getClientConfig',
  'patchClientConfig',
  'createIntegrationMode',
  'getIntegrationModes',
]));

jest.unstable_mockModule(`${CONTROLLERS}/master/masterClientConfig.controller.js`, () => handlers([
  'createMasterClientConfigHandler',
  'deleteMasterClientConfigHandler',
  'getMasterClientConfigs',
  'patchMasterClientConfigHandler',
]));

jest.unstable_mockModule(`${CONTROLLERS}/mapping.controller.js`, () => handlers([
  'applyMappingTest',
  'createAdminMapping',
  'createMapping',
  'getMappings',
]));

jest.unstable_mockModule(`${CONTROLLERS}/dealMapping.controller.js`, () => ({
  default: handlers([
    'listPipelines', 'createPipeline', 'patchPipeline', 'deletePipeline',
    'listStages', 'createStage', 'patchStage', 'deleteStage',
  ]),
}));

jest.unstable_mockModule(`${CONTROLLERS}/ownerMapping.controller.js`, () => ({
  default: handlers(['listOwners', 'createOwner', 'getOwner', 'patchOwner', 'deleteOwner']),
}));

jest.unstable_mockModule(`${CONTROLLERS}/sapCredentials.controller.js`, () => ({
  default: handlers([
    'createSapCredentials',
    'listSapCredentials',
    'getSapCredentials',
    'patchSapCredentials',
    'deleteSapCredentials',
  ]),
}));

jest.unstable_mockModule(`${CONTROLLERS}/sapSync.controller.js`, () => handlers([
  'activateSapSyncConfig',
  'deactivateSapSyncConfig',
  'deleteTenantSapSyncJobs',
  'getSapSyncJobsSnapshot',
  'resyncSapSyncScheduler',
  'runSapSyncConfigManually',
  'runTenantConfigNow',
  'syncTenantConfigSchedule',
  'triggerSapSync',
  'triggerWebHook',
]));

jest.unstable_mockModule(`${CONTROLLERS}/oauth.controller.js`, () => handlers([
  'initOAuthForTenant',
  'oauthCallback',
]));

jest.unstable_mockModule('../../../src/composition/webhooks.composition.js', () => ({
  buildCreateDealController: handler,
  buildCreateQuotationController: handler,
  buildUpdateQuotationController: handler,
  buildConvertQuotationToOrderController: handler,
  buildInventoryTransferRequestController: handler,
  buildPurchaseQuotationController: handler,
}));

jest.unstable_mockModule(`${CONTROLLERS}/lineItemPrice.controller.js`, () => ({
  default: { syncPrices: handler() },
  createLineItemPriceController: () => ({ syncPrices: handler() }),
}));

jest.unstable_mockModule('../../../src/composition/s4-line-item-prices.composition.js', () => ({
  buildS4LineItemPriceControllerDependencies: () => ({}),
}));

const ROUTES = '../../../src/interfaces/http/routes';

// Panel de soporte (/panel/api): plugin real con casos de uso reales sobre dobles en memoria.
const PANEL_SECRET = 'route-wiring-panel-secret-32-chars-minimum';
const { default: panelPlugin } = await import('../../../src/interfaces/http/panel/panelPlugin.js');
const { buildPanelUseCases } = await import('../../../src/composition/panel.composition.js');
const { default: HmacSessionToken } = await import('../../../src/infrastructure/auth/HmacSessionToken.js');
const panelFakes = await import('../application/panel/panelFakes.js');
const ticketFakes = await import('../application/panel/ticketFakes.js');
const operationFakes = await import('../application/panel/operationFakes.js');

const panelStaff = panelFakes.staffUser();
const panelClient = panelFakes.clientUser();
const panelTokens = new HmacSessionToken({ secret: PANEL_SECRET });
const panelRevokedSessions = new panelFakes.FakeRevokedSessions();
const panelUseCases = buildPanelUseCases({
  secret: PANEL_SECRET,
  userRepository: new panelFakes.InMemoryPanelUserRepository([panelStaff, panelClient]),
  tenantDirectory: new panelFakes.FakeTenantDirectory(panelFakes.TENANTS),
  passwordHasher: new panelFakes.FakePasswordHasher(),
  temporaryPasswordGenerator: new panelFakes.SequenceTemporaryPassword(),
  loginAttempts: new panelFakes.FakeLoginAttempts(),
  auditLog: new panelFakes.RecordingAuditLog(),
  revokedSessions: panelRevokedSessions,
  sessionToken: panelTokens,
  ticketRepository: new ticketFakes.InMemoryTicketRepository(),
  attachmentStore: new ticketFakes.FakeAttachmentStore(),
  contextReader: new ticketFakes.FakeContextReader(),
  operationsReader: new operationFakes.FakeOperationsReader(operationFakes.sampleOperations()),
  fieldMappingReader: new operationFakes.FakeFieldMappingReader(operationFakes.sampleFieldMappings()),
  logger: { warn() {}, error() {}, info() {} },
});
const STAFF_PANEL_COOKIE = `panel_session=${panelTokens.sign({ sub: panelStaff.id, tv: 0, pwdChange: false })}`;
const CLIENT_PANEL_COOKIE = `panel_session=${panelTokens.sign({ sub: panelClient.id, tv: 0, pwdChange: false })}`;
// Secuencial a propósito: Jest ESM no enlaza bien imports dinámicos en paralelo que comparten
// dependencias (internalAuth -> env.js).
const routeModules = [];
for (const file of [
  'config.routes.js',
  'mapping.routes.js',
  'dealMapping.routes.js',
  'ownerMapping.routes.js',
  'sapCredentials.routes.js',
  'sapSync.routes.js',
  'oauth.routes.js',
  'webhook.routes.js',
  'lineItemPrice.routes.js',
]) {
  routeModules.push(await import(`${ROUTES}/${file}`));
}

let app;

beforeAll(async () => {
  app = Fastify();
  routeModules.forEach((module) => app.register(module.default));
  app.register(panelPlugin, {
    prefix: '/panel/api',
    secret: PANEL_SECRET,
    useCases: panelUseCases,
    logger: { warn: () => {}, error: () => {} },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mockTenantResolver.mockClear();
  mockAdminTenantResolver.mockClear();
});

function inject(method, url, headers = {}) {
  const withBody = ['POST', 'PATCH', 'PUT'].includes(method);
  return app.inject({
    method,
    url,
    headers: withBody ? { 'content-type': 'application/json', ...headers } : headers,
    ...(withBody ? { payload: {} } : {}),
  });
}

// Configuración y credenciales de un tenant: llave interna + tenant por header.
const ADMIN_TENANT_ROUTES = [
  ['POST', '/config/client'],
  ['GET', '/config/client'],
  ['PATCH', '/config/client/cfg-1'],
  ['POST', '/config/mode'],
  ['GET', '/config/mode'],
  ['POST', '/config/sap-credentials'],
  ['GET', '/config/sap-credentials'],
  ['GET', '/config/sap-credentials/cred-1'],
  ['PATCH', '/config/sap-credentials/cred-1'],
  ['DELETE', '/config/sap-credentials/cred-1'],
  ['POST', '/mapping'],
  ['GET', '/mapping'],
  ['POST', '/mapping/test'],
  ['POST', '/admin/mapping'],
  ['GET', '/mappings/deal-pipelines'],
  ['POST', '/mappings/deal-pipelines'],
  ['PATCH', '/mappings/deal-pipelines/p-1'],
  ['DELETE', '/mappings/deal-pipelines/p-1'],
  ['GET', '/mappings/deal-stages'],
  ['POST', '/mappings/deal-stages'],
  ['PATCH', '/mappings/deal-stages/s-1'],
  ['DELETE', '/mappings/deal-stages/s-1'],
  ['GET', '/mappings/owners'],
  ['POST', '/mappings/owners'],
  ['GET', '/mappings/owners/o-1'],
  ['PATCH', '/mappings/owners/o-1'],
  ['DELETE', '/mappings/owners/o-1'],
  ['POST', '/sap-sync/config/cfg-1/run'],
  ['POST', '/sap-sync/config/cfg-1/sync-schedule'],
];

// Operaciones del equipo que no dependen de un tenant del request: solo llave interna.
const INTERNAL_ONLY_ROUTES = [
  ['POST', '/master/config/client'],
  ['GET', '/master/config/client'],
  ['PATCH', '/master/config/client/m-1'],
  ['DELETE', '/master/config/client/m-1'],
  ['POST', '/sap-sync/run'],
  ['POST', '/sap-sync/runWebHook'],
  ['POST', '/oauth/hubspot/init'],
];

// Lo que llama HubSpot: no puede mandar la llave interna. Su autenticación es la Fase B.
const HUBSPOT_WEBHOOK_ROUTES = [
  ['POST', '/webhooks/hubspot/createDeal'],
  ['POST', '/webhooks/hubspot/createQuotation'],
  ['POST', '/webhooks/hubspot/updateQuotation'],
  ['POST', '/webhooks/hubspot/convertQuotationToOrder'],
  ['POST', '/webhooks/hubspot/inventoryTransferRequest'],
  ['POST', '/webhooks/hubspot/purchaseQuotation'],
  ['POST', '/webhooks/hubspot/line-items/prices'],
  ['POST', '/webhooks/hubspot/line-items/prices/s4'],
];

describe.each(ADMIN_TENANT_ROUTES)('%s %s', (method, url) => {
  it('rejects a bare x-tenant-id without the internal key', async () => {
    const response = await inject(method, url, { 'x-tenant-id': 'tenant-1' });

    expect(response.statusCode).toBe(403);
    expect(mockAdminTenantResolver).not.toHaveBeenCalled();
    expect(mockTenantResolver).not.toHaveBeenCalled();
  });

  it('resolves the tenant with the admin resolver once the internal key is present', async () => {
    const response = await inject(method, url, {
      'x-internal-key': INTERNAL_KEY,
      'x-tenant-id': 'tenant-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tenantKey).toBe('resolved-by-admin-resolver');
    expect(mockTenantResolver).not.toHaveBeenCalled();
  });
});

describe.each(INTERNAL_ONLY_ROUTES)('%s %s', (method, url) => {
  it('rejects requests without the internal key', async () => {
    const response = await inject(method, url);

    expect(response.statusCode).toBe(403);
  });

  it('accepts requests with the internal key', async () => {
    const response = await inject(method, url, { 'x-internal-key': INTERNAL_KEY });

    expect(response.statusCode).toBe(200);
  });
});

describe.each(HUBSPOT_WEBHOOK_ROUTES)('%s %s', (method, url) => {
  it('stays reachable for HubSpot without the internal key', async () => {
    const response = await inject(method, url, { 'x-tenant-id': 'tenant-1' });

    expect(response.statusCode).toBe(200);
    expect(response.json().tenantKey).toBe('resolved-by-webhook-resolver');
    expect(mockAdminTenantResolver).not.toHaveBeenCalled();
  });
});

describe('OAuth routes', () => {
  it('keeps the callback public because HubSpot redirects the browser there', async () => {
    const response = await inject('GET', '/oauth/hubspot/callback?code=c&state=s');

    expect(response.statusCode).toBe(200);
  });

  it('no longer exposes the legacy GET init route', async () => {
    const response = await inject('GET', '/oauth/hubspot/init/cfg-1', {
      'x-internal-key': INTERNAL_KEY,
      'x-tenant-id': 'tenant-1',
    });

    expect(response.statusCode).toBe(404);
  });
});

// Panel de soporte. Cada ruta declara si es pública, si pide solo sesión o qué permiso exige
// (spec, Seguridad 8). 'staff' = cualquiera de los permisos de staff.
const PANEL_ROUTES = [
  ['POST', '/panel/api/auth/login', 'public'],
  ['POST', '/panel/api/auth/logout', 'public'],
  ['GET', '/panel/api/auth/me', 'session'],
  ['POST', '/panel/api/auth/change-password', 'session'],
  ['GET', '/panel/api/staff/users', 'staff.users'],
  ['POST', '/panel/api/staff/users', 'staff.users'],
  ['PATCH', '/panel/api/staff/users/ffffffffffffffffffffffff', 'staff.users'],
  ['POST', '/panel/api/staff/users/ffffffffffffffffffffffff/reset-password', 'staff.users'],
  ['GET', '/panel/api/staff/tenants', 'staff'],
  // Soporte del cliente: permisos tickets.* (Smarteam no los tiene: usa los de staff).
  ['GET', '/panel/api/tickets', 'client'],
  ['POST', '/panel/api/tickets', 'client'],
  ['GET', '/panel/api/tickets/ffffffffffffffffffffffff', 'client'],
  ['POST', '/panel/api/tickets/ffffffffffffffffffffffff/messages', 'client'],
  ['POST', '/panel/api/tickets/ffffffffffffffffffffffff/reopen', 'client'],
  ['GET', '/panel/api/tickets/ffffffffffffffffffffffff/attachments/ffffffffffffffffffffffff', 'client'],
  // Bandeja y acciones de Smarteam: staff.tickets.
  ['GET', '/panel/api/staff/tickets', 'staff.tickets'],
  ['GET', '/panel/api/staff/tickets/summary', 'staff.tickets'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/tickets/ffffffffffffffffffffffff', 'staff.tickets'],
  ['POST', '/panel/api/staff/tenants/sap_integration_acme/tickets/ffffffffffffffffffffffff/messages', 'staff.tickets'],
  ['POST', '/panel/api/staff/tenants/sap_integration_acme/tickets/ffffffffffffffffffffffff/status', 'staff.tickets'],
  ['POST', '/panel/api/staff/tenants/sap_integration_acme/tickets/ffffffffffffffffffffffff/resolve', 'staff.tickets'],
  ['PUT', '/panel/api/staff/tenants/sap_integration_acme/tickets/ffffffffffffffffffffffff/internal-resolution', 'staff.tickets'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/tickets/ffffffffffffffffffffffff/attachments/ffffffffffffffffffffffff', 'staff.tickets'],
  // Eventos y syncs: rutas de cliente (cuenta con tenant) y de staff por empresa (solo Smarteam).
  ['GET', '/panel/api/events', 'client'],
  ['GET', '/panel/api/events/ffffffffffffffffffffffff', 'client'],
  ['GET', '/panel/api/syncs', 'client'],
  ['GET', '/panel/api/syncs/ffffffffffffffffffffffff', 'client'],
  ['GET', '/panel/api/sync-tasks', 'client'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/events', 'staff account + events.read'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/events/ffffffffffffffffffffffff', 'staff account + events.read'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/syncs', 'staff account + syncs.read'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/syncs/ffffffffffffffffffffffff', 'staff account + syncs.read'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/sync-tasks', 'staff account + syncs.read'],
  // Plan 5: tableros y métricas.
  ['GET', '/panel/api/dashboard/integration', 'client'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/dashboard/integration', 'staff account + events.read'],
  ['GET', '/panel/api/tickets/metrics', 'client'],
  ['GET', '/panel/api/staff/tickets/metrics', 'staff account + staff.tickets'],
  // Plan 6: mapeo de campos (solo lectura).
  ['GET', '/panel/api/field-mappings', 'client'],
  ['GET', '/panel/api/staff/tenants/sap_integration_acme/field-mappings', 'staff account + mappings.read'],
];

function panelInject(method, url, cookie) {
  const headers = { 'x-panel-request': '1' };
  if (cookie) {
    headers.cookie = cookie;
  }
  return inject(method, url, headers);
}

describe.each(PANEL_ROUTES)('panel %s %s (%s)', (method, url, guard) => {
  if (guard === 'public') {
    it('does not ask for a session', async () => {
      const response = await panelInject(method, url);

      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    });
    return;
  }

  it('answers 401 without a panel session', async () => {
    const response = await panelInject(method, url);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('does not accept x-internal-key instead of a panel session', async () => {
    const response = await inject(method, url, { 'x-panel-request': '1', 'x-internal-key': INTERNAL_KEY });

    expect(response.statusCode).toBe(401);
  });

  if (guard === 'session') {
    it('lets any account with a session through', async () => {
      const response = await panelInject(method, url, CLIENT_PANEL_COOKIE);

      expect([401, 403]).not.toContain(response.statusCode);
    });
    return;
  }

  // Rutas de cliente: Smarteam no tiene tickets.*; el resto: el cliente no tiene permisos de staff.
  const withoutPermission = guard === 'client' ? STAFF_PANEL_COOKIE : CLIENT_PANEL_COOKIE;
  const withPermission = guard === 'client' ? CLIENT_PANEL_COOKIE : STAFF_PANEL_COOKIE;

  it('answers 403 forbidden to an account without the permission', async () => {
    const response = await panelInject(method, url, withoutPermission);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });
  });

  it('lets an account with the permission through', async () => {
    const response = await panelInject(method, url, withPermission);

    expect([401, 403]).not.toContain(response.statusCode);
  });
});

describe('panel session revoked by logout', () => {
  it('answers 401 on every protected panel route', async () => {
    const token = panelTokens.sign({ sub: panelStaff.id, tv: 0, pwdChange: false });
    const { sid } = panelTokens.verify(token);
    await panelRevokedSessions.revoke({ sid, userId: panelStaff.id, expiresAt: new Date(Date.now() + 60000) });

    const response = await inject('GET', '/panel/api/auth/me', { cookie: `panel_session=${token}` });

    expect(response.statusCode).toBe(401);
  });
});

describe('panel session against the existing routes', () => {
  it.each([...ADMIN_TENANT_ROUTES, ...INTERNAL_ONLY_ROUTES])(
    'a valid panel session does not open %s %s',
    async (method, url) => {
      const response = await inject(method, url, { cookie: STAFF_PANEL_COOKIE, 'x-tenant-id': 'tenant-1' });

      expect(response.statusCode).toBe(403);
      expect(mockAdminTenantResolver).not.toHaveBeenCalled();
    }
  );
});
