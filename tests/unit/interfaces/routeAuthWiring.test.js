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
