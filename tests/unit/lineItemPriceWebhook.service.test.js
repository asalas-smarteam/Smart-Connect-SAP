import { jest } from '@jest/globals';

const mockGetAccessToken = jest.fn();
const mockHubspotGet = jest.fn();
const mockBatchUpdateLineItems = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotAuthService.js', () => ({
  default: {
    getAccessToken: mockGetAccessToken,
  },
}));

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  hubspotGet: mockHubspotGet,
  batchUpdateLineItems: mockBatchUpdateLineItems,
}));

jest.unstable_mockModule('../../src/infrastructure/logger/logger.js', () => ({
  default: {
    warn: mockLoggerWarn,
  },
}));

const lineItemPriceWebhookService = (
  await import('../../src/infrastructure/webhook/lineItemPriceWebhook.service.js')
).default;

function buildTenantModels() {
  return {
    HubspotCredentials: {
      findOne: jest.fn()
        .mockResolvedValueOnce({
          clientConfigId: 'client-config-1',
          portalId: '50564010',
          accessToken: 'access-token',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
    },
    LineItemPriceWebhookEvent: {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      }),
      create: jest.fn().mockResolvedValue({ _id: 'event-1' }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      // Reclamación atómica del intento fallido. Por defecto no hay nada que reclamar, así que
      // el flujo sigue derecho al create como antes de que existiera este método.
      findOneAndUpdate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    },
    Configuration: {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue({ value: undefined }),
    },
  };
}

function mockConfigurationValues(tenantModels, values) {
  tenantModels.Configuration.findOneAndUpdate = jest.fn().mockImplementation(
    async ({ key }) => ({ value: values[key] })
  );
}

function leanResult(value) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

// findOneAndUpdate proyecta con la opción `projection`, así que devuelve .lean() directo, sin
// .select() intermedio.
function leanDocument(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

// Simula el ÚNICO registro que puede existir para un payload dado: el índice único parcial cubre
// los mismos 6 campos que el filtro de duplicados, así que nunca hay dos.
//
// Responde según el ESTADO del registro en vez de devolver lo que se haya encolado. Sin esto, un
// test no puede distinguir un reenvío de un evento ya enviado (isSend: true) de uno en vuelo
// (errorMessage: null): con returns encolados los dos casos son el mismo mock.
function stubStoredEvent(tenantModels, stored) {
  const isLiveDuplicate = Boolean(stored) && (stored.isSend === true || stored.errorMessage === null);
  const isReclaimableFailure = Boolean(stored) && stored.isSend === false && stored.errorMessage !== null;

  tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
    .mockReturnValue(leanResult(isLiveDuplicate ? { _id: stored._id } : null));
  tenantModels.LineItemPriceWebhookEvent.findOneAndUpdate = jest.fn()
    .mockReturnValue(leanDocument(isReclaimableFailure ? { _id: stored._id } : null));
}

function buildAssociationPayload(overrides = {}) {
  return {
    eventId: 2073333923,
    subscriptionId: 6955444,
    portalId: 50249912,
    appId: 36665006,
    occurredAt: 1786997905997,
    associationType: 'DEAL_TO_LINE_ITEM',
    changeSource: 'USER',
    fromObjectId: 64058987777,
    ...overrides,
  };
}

// Deal 64058987777: una company con idsap y una sola línea legible.
function mockPriceableDeal() {
  mockGetAccessToken.mockResolvedValue('hubspot-token');
  mockHubspotGet.mockImplementation(async (_token, path) => {
    if (path === '/crm/v3/objects/deals/64058987777') {
      return {
        id: '64058987777',
        associations: {
          companies: { results: [{ id: 'company-1' }] },
          'line items': { results: [{ id: 'line-1' }] },
        },
      };
    }
    if (path === '/crm/v3/objects/companies/company-1') {
      return { id: 'company-1', properties: { idsap: 'C20000' } };
    }
    return { id: 'line-1', properties: { hs_sku: 'A0001', quantity: '1' } };
  });
}

function buildPropertyChangePayload(overrides = {}) {
  return {
    eventId: 1858073298,
    subscriptionId: 6948787,
    portalId: 50249912,
    appId: 36665006,
    occurredAt: 1783002936606,
    subscriptionType: 'line_item.propertyChange',
    attemptNumber: 0,
    objectId: 56816252584,
    propertyName: 'miscelaneo',
    propertyValue: '10',
    changeSource: 'CRM_UI',
    sourceId: 'userId:82534997',
    ...overrides,
  };
}

function mockDealWithLineItems(itemsByPath) {
  mockHubspotGet.mockImplementation(async (_token, path, params = {}) => {
    if (path === '/crm/v3/objects/line_items/56816252584' && params.associations === 'deals') {
      return {
        id: '56816252584',
        associations: { deals: { results: [{ id: '900100' }] } },
      };
    }

    if (path === '/crm/v3/objects/deals/900100') {
      // HubSpot devuelve la asociación de line items con espacio: "line items".
      return {
        id: '900100',
        associations: {
          'line items': {
            results: Object.keys(itemsByPath).map((id) => ({ id })),
          },
        },
      };
    }

    const itemId = path.replace('/crm/v3/objects/line_items/', '');
    if (itemsByPath[itemId]) {
      return { id: itemId, properties: itemsByPath[itemId] };
    }

    return null;
  });
}

describe('lineItemPriceWebhook.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockReset();
    mockHubspotGet.mockReset();
    mockBatchUpdateLineItems.mockReset();
  });

  it('skips events that are not DEAL_TO_LINE_ITEM from USER', async () => {
    const tenantModels = buildTenantModels();

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        associationType: 'DEAL_TO_CONTACT',
        changeSource: 'USER',
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: {
        skipped: true,
        reason: 'unsupported_event',
      },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.findOne).not.toHaveBeenCalled();
  });

  it('skips events when changeSource is not USER', async () => {
    const tenantModels = buildTenantModels();

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'INTEGRATION',
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: {
        skipped: true,
        reason: 'unsupported_event',
      },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.findOne).not.toHaveBeenCalled();
  });

  it('skips duplicated webhook payloads', async () => {
    const tenantModels = buildTenantModels();
    tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'event-1' }),
      }),
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: 'event-1',
      meta: {
        skipped: true,
        reason: 'duplicate_event',
      },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('processes a HubSpot retry after a failed attempt instead of skipping it as duplicate', async () => {
    const tenantModels = buildTenantModels();

    // Registro del intento fallido: isSend false Y errorMessage no nulo.
    stubStoredEvent(tenantModels, {
      _id: 'event-previous',
      isSend: false,
      errorMessage: 'HubSpot 404',
    });
    mockPriceableDeal();

    const result = await lineItemPriceWebhookService.preparePayload(
      buildAssociationPayload(),
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result.skip).toBe(false);
    expect(result.executionId).toBe('event-previous');
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
    // La reclamación es un solo findOneAndUpdate: leer y resetear por separado dejaba que dos
    // reintentos simultáneos se quedaran los dos con el mismo registro.
    expect(tenantModels.LineItemPriceWebhookEvent.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ isSend: false, errorMessage: { $ne: null } }),
      { $set: { errorMessage: null } },
      { new: true, projection: { _id: 1 } }
    );
  });

  it('still skips a resend of an already successful event', async () => {
    const tenantModels = buildTenantModels();
    stubStoredEvent(tenantModels, { _id: 'event-done', isSend: true, errorMessage: null });

    const result = await lineItemPriceWebhookService.preparePayload(
      buildAssociationPayload(),
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result).toMatchObject({
      skip: true,
      executionId: 'event-done',
      meta: { reason: 'duplicate_event' },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
    // Sólo un registro ya enviado o en vuelo cuenta como duplicado: el $or es lo que
    // distingue eso de un fallo nuestro reintentable.
    expect(tenantModels.LineItemPriceWebhookEvent.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ $or: [{ isSend: true }, { errorMessage: null }] })
    );
  });

  it('still skips a resend of an event that is currently in flight', async () => {
    const tenantModels = buildTenantModels();
    // isSend false pero errorMessage null: nadie registró un fallo todavía, así que sigue
    // corriendo. Reprocesarlo valorizaría el deal dos veces en paralelo.
    stubStoredEvent(tenantModels, { _id: 'event-in-flight', isSend: false, errorMessage: null });

    const result = await lineItemPriceWebhookService.preparePayload(
      buildAssociationPayload(),
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result).toMatchObject({
      skip: true,
      executionId: 'event-in-flight',
      meta: { reason: 'duplicate_event' },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
    expect(tenantModels.LineItemPriceWebhookEvent.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockHubspotGet).not.toHaveBeenCalled();
  });

  it('skips instead of adopting a concurrent in-flight record when the create hits the unique index', async () => {
    const tenantModels = buildTenantModels();

    // Dos entregas casi simultáneas del mismo evento, A y B. Esta es B: cuando pasó el guard no
    // había registro, y A insertó el suyo antes de que B llegara al create.
    tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
      // Guard: todavía no existía nada.
      .mockReturnValueOnce(leanResult(null))
      // Cualquier findOne posterior con el filtro pelado SÍ ve el registro en vuelo de A. Si el
      // fallback del E11000 volviera a usar ese filtro, adoptaría este registro y valorizaría el
      // deal por segunda vez.
      .mockReturnValue(leanResult({ _id: 'event-a' }));
    // El registro de A está en vuelo (errorMessage null), así que no es reclamable.
    tenantModels.LineItemPriceWebhookEvent.findOneAndUpdate = jest.fn()
      .mockReturnValue(leanDocument(null));
    tenantModels.LineItemPriceWebhookEvent.create = jest.fn()
      .mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));

    mockPriceableDeal();

    const result = await lineItemPriceWebhookService.preparePayload(
      buildAssociationPayload(),
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result).toMatchObject({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'duplicate_event' },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalled();
    // Lo que importa: la entrega perdedora no llegó a valorizar nada ni a escribir el resultado
    // sobre el registro de A.
    expect(mockHubspotGet).not.toHaveBeenCalled();
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).not.toHaveBeenCalled();
  });

  it('records the error and the audit against the reused record when the retry fails again', async () => {
    const tenantModels = buildTenantModels();

    stubStoredEvent(tenantModels, {
      _id: 'event-previous',
      isSend: false,
      errorMessage: 'HubSpot 404',
    });

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockRejectedValue(Object.assign(
      new Error('HubSpot API request failed: 502 Bad Gateway'),
      { details: { status: 502, endpoint: '/crm/v3/objects/deals/64058987777' } }
    ));

    await expect(lineItemPriceWebhookService.preparePayload(
      buildAssociationPayload(),
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    )).rejects.toThrow('HubSpot API request failed: 502 Bad Gateway');

    // El audit de Task 8 tiene que caer sobre el registro REUTILIZADO, no sobre uno nuevo.
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-previous' },
      { $set: { isSend: false, errorMessage: 'HubSpot API request failed: 502 Bad Gateway' } }
    );
    const auditCall = tenantModels.LineItemPriceWebhookEvent.updateOne.mock.calls
      .find(([, update]) => update?.$set?.audit);
    expect(auditCall[0]).toEqual({ _id: 'event-previous' });
    expect(auditCall[1].$set.audit.fatalError).toMatchObject({
      message: 'HubSpot API request failed: 502 Bad Gateway',
      status: 502,
      endpoint: '/crm/v3/objects/deals/64058987777',
    });
  });

  it('rethrows a create error that is not a unique index violation', async () => {
    const tenantModels = buildTenantModels();
    tenantModels.LineItemPriceWebhookEvent.create = jest.fn()
      .mockRejectedValue(new Error('connection lost'));

    await expect(lineItemPriceWebhookService.preparePayload(
      buildAssociationPayload(),
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    )).rejects.toThrow('connection lost');
  });

  it('builds the legacy payload with two of three lines when one line 404s', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/64058987777') {
        return {
          id: '64058987777',
          associations: {
            companies: { results: [{ id: 'company-1' }] },
            'line items': { results: [{ id: 'line-1' }, { id: 'line-2' }, { id: 'line-3' }] },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/company-1') {
        return { id: 'company-1', properties: { idsap: 'C20000' } };
      }

      if (path === '/crm/v3/objects/line_items/line-2') {
        throw Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
          details: { endpoint: path, method: 'GET', status: 404 },
        });
      }

      return { id: path.split('/').pop(), properties: { hs_sku: 'A0001', quantity: '1' } };
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 2073333923,
        subscriptionId: 6955444,
        portalId: 50249912,
        appId: 36665006,
        occurredAt: 1786997905997,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 64058987777,
      },
      { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
    );

    expect(result.skip).toBe(false);
    expect(result.payload.lineItems.map((line) => line.id)).toEqual(['line-1', 'line-3']);
    expect(result.payload.lineItemFailures).toEqual([{
      id: 'line-2',
      stage: 'hubspot_read',
      reason: 'HubSpot API request failed: 404 Not Found',
      status: 404,
      endpoint: '/crm/v3/objects/line_items/line-2',
    }]);
    expect(result.payload.cardCode).toBe('C20000');
  });

  it('rejects with "Deal has no readable line items" when every associated line item 404s', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/64058987778') {
        return {
          id: '64058987778',
          associations: {
            companies: { results: [{ id: 'company-1' }] },
            'line items': { results: [{ id: 'line-1' }, { id: 'line-2' }] },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/company-1') {
        return { id: 'company-1', properties: { idsap: 'C20000' } };
      }

      throw Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
        details: { endpoint: path, method: 'GET', status: 404 },
      });
    });

    await expect(
      lineItemPriceWebhookService.preparePayload(
        {
          eventId: 2073333924,
          subscriptionId: 6955445,
          portalId: 50249912,
          appId: 36665006,
          occurredAt: 1786997905998,
          associationType: 'DEAL_TO_LINE_ITEM',
          changeSource: 'USER',
          fromObjectId: 64058987778,
        },
        { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
      )
    ).rejects.toThrow('Deal has no readable line items');

    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: {
          isSend: false,
          errorMessage: 'Deal has no readable line items',
        },
      }
    );
  });

  // Éste es el caso que reportó el cliente: el 404 cae sobre el GET del deal, así que
  // SyncLineItemPrices nunca corre y su audit nunca existe. Si acá no se guarda uno mínimo,
  // el evento vuelve a quedar con un solo `errorMessage` y nadie puede decir por qué falló.
  it('persists a minimal audit with the endpoint and status when the deal read itself fails', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      throw Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
        details: { endpoint: path, method: 'GET', status: 404 },
      });
    });

    await expect(
      lineItemPriceWebhookService.preparePayload(
        {
          eventId: 2073333925,
          subscriptionId: 6955446,
          portalId: 50249912,
          appId: 36665006,
          occurredAt: 1786997905999,
          associationType: 'DEAL_TO_LINE_ITEM',
          changeSource: 'USER',
          fromObjectId: 64058987778,
        },
        { tenantModels, tenant: { client: { hubspot: { portalId: '50249912' } } } }
      )
    ).rejects.toThrow('HubSpot API request failed: 404 Not Found');

    // Dos escrituras separadas: si Mongo rechazara el audit, el `errorMessage` ya quedó.
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledTimes(2);
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: 'event-1' },
      {
        $set: {
          isSend: false,
          errorMessage: 'HubSpot API request failed: 404 Not Found',
        },
      }
    );
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'event-1' },
      {
        $set: {
          audit: expect.objectContaining({
            dealId: '64058987778',
            rounds: [],
            calls: [],
            unresolved: [],
            fatalError: {
              message: 'HubSpot API request failed: 404 Not Found',
              status: 404,
              endpoint: '/crm/v3/objects/deals/64058987778',
            },
          }),
        },
      }
    );
  });

  it('rejects with the company/contact error before touching line items when a deal has neither', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/58986911597') {
        return {
          id: '58986911597',
          associations: {
            companies: { results: [] },
            contacts: { results: [] },
            // A propósito hay líneas asociadas: si el código alguna vez volviera a
            // resolver/leer line items antes que cardCode, este mock nunca las
            // devolvería (siempre lanza) y el test fallaría por la razón equivocada.
            'line items': { results: [{ id: 'line-1' }] },
          },
        };
      }

      throw new Error(`unexpected HubSpot call: ${path}`);
    });

    await expect(
      lineItemPriceWebhookService.preparePayload(
        {
          eventId: 797713316,
          subscriptionId: 6174091,
          portalId: 50564010,
          appId: 31481725,
          occurredAt: 1775764313529,
          associationType: 'DEAL_TO_LINE_ITEM',
          changeSource: 'USER',
          fromObjectId: 58986911597,
        },
        {
          tenantModels,
          tenant: { client: { hubspot: { portalId: '50564010' } } },
        }
      )
    ).rejects.toThrow('Associated company or contact is required for the deal');

    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: {
          isSend: false,
          errorMessage: 'Associated company or contact is required for the deal',
        },
      }
    );
  });

  it('builds the legacy payload from the HubSpot deal associations', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/58986911596') {
        return {
          id: '58986911596',
          associations: {
            companies: {
              results: [{ id: '201' }],
            },
            contacts: {
              results: [{ id: '301' }],
            },
            line_items: {
              results: [{ id: '54118822955' }, { id: '54118822956' }],
            },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/201') {
        return {
          id: '201',
          properties: {
            idsap: 'CL00129',
          },
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822955') {
        return {
          id: '54118822955',
          properties: {
            hs_sku: 'A01050211',
            quantity: '2',
          },
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822956') {
        return {
          id: '54118822956',
          properties: {
            hs_sku: 'A01050007',
            quantity: '0',
          },
        };
      }

      return null;
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: false,
      payload: {
        dealId: '58986911596',
        cardCode: 'CL00129',
        lineItems: [
          {
            id: '54118822955',
            itemCode: 'A01050211',
            quantity: '2',
            properties: { hs_sku: 'A01050211', quantity: '2' },
          },
          {
            id: '54118822956',
            itemCode: 'A01050007',
            quantity: '0',
            properties: { hs_sku: 'A01050007', quantity: '0' },
          },
        ],
        lineItemFailures: [],
      },
      executionId: 'event-1',
    });

    expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
      payload: {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      isSend: false,
      errorMessage: null,
    });

    expect(mockHubspotGet).toHaveBeenNthCalledWith(
      1,
      'hubspot-token',
      '/crm/v3/objects/deals/58986911596',
      { associations: 'companies,contacts,line_items' }
    );
  });

  it('includes configured misc line item property in the legacy payload', async () => {
    const tenantModels = buildTenantModels();

    tenantModels.Configuration.findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        key: 'requireExtraValueInUnitPrice',
        value: {
          enableMiscPriceCalculation: true,
          originalPriceTargetProperty: 'safe_amount',
          miscSourceProperty: 'misc',
          miscCalculationType: 'porcentual',
        },
      }),
    });

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/58986911596') {
        return {
          id: '58986911596',
          associations: {
            companies: { results: [{ id: '201' }] },
            contacts: { results: [] },
            line_items: { results: [{ id: '54118822955' }] },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/201') {
        return {
          id: '201',
          properties: { idsap: 'CL00129' },
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822955') {
        return {
          id: '54118822955',
          properties: {
            hs_sku: 'A01050211',
            quantity: '2',
            misc: '15',
          },
        };
      }

      return null;
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result.payload.lineItems).toEqual([
      {
        id: '54118822955',
        itemCode: 'A01050211',
        quantity: '2',
        misc: '15',
        properties: { hs_sku: 'A01050211', quantity: '2', misc: '15' },
      },
    ]);
    expect(mockHubspotGet).toHaveBeenCalledWith(
      'hubspot-token',
      '/crm/v3/objects/line_items/54118822955',
      { properties: 'hs_sku,quantity,misc' }
    );
  });

  it('stores the error message when the HubSpot preprocessing fails', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockResolvedValueOnce({
      id: '58986911596',
      associations: {
        companies: { results: [] },
        contacts: { results: [] },
        line_items: { results: [] },
      },
    });

    await expect(
      lineItemPriceWebhookService.preparePayload(
        {
          eventId: 797713315,
          subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
        {
          tenantModels,
          tenant: { client: { hubspot: { portalId: '50564010' } } },
        }
      )
    ).rejects.toThrow('Associated company or contact is required for the deal');

    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: {
          isSend: false,
          errorMessage: 'Associated company or contact is required for the deal',
        },
      }
    );
  });

  it('returns payload without cardCode when company and contact have no sapId', async () => {
    const tenantModels = buildTenantModels();

    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockHubspotGet.mockImplementation(async (_token, path) => {
      if (path === '/crm/v3/objects/deals/58986911596') {
        return {
          id: '58986911596',
          associations: {
            companies: {
              results: [{ id: '201' }],
            },
            contacts: {
              results: [{ id: '301' }],
            },
            line_items: {
              results: [{ id: '54118822955' }],
            },
          },
        };
      }

      if (path === '/crm/v3/objects/companies/201') {
        return {
          id: '201',
          properties: {},
        };
      }

      if (path === '/crm/v3/objects/contacts/301') {
        return {
          id: '301',
          properties: {},
        };
      }

      if (path === '/crm/v3/objects/line_items/54118822955') {
        return {
          id: '54118822955',
          properties: {
            hs_sku: 'A01050211',
            quantity: '0',
          },
        };
      }

      return null;
    });

    const result = await lineItemPriceWebhookService.preparePayload(
      {
        eventId: 797713315,
        subscriptionId: 6174090,
        portalId: 50564010,
        appId: 31481725,
        occurredAt: 1775764313528,
        associationType: 'DEAL_TO_LINE_ITEM',
        changeSource: 'USER',
        fromObjectId: 58986911596,
      },
      {
        tenantModels,
        tenant: { client: { hubspot: { portalId: '50564010' } } },
      }
    );

    expect(result).toEqual({
      skip: false,
      payload: {
        dealId: '58986911596',
        cardCode: null,
        lineItems: [
          {
            id: '54118822955',
            itemCode: 'A01050211',
            quantity: '0',
            properties: { hs_sku: 'A01050211', quantity: '0' },
          },
        ],
        lineItemFailures: [],
      },
      executionId: 'event-1',
    });
  });

  describe('propertyChange SkippedVersion flow', () => {
    const tenant = { client: { hubspot: { portalId: '50249912' } } };

    it('runs the legacy single line item flow when the mode config is the default', async () => {
      const tenantModels = buildTenantModels();

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockHubspotGet.mockResolvedValue({
        id: '56816252584',
        properties: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload(),
        { tenantModels, tenant }
      );

      expect(result.meta.reason).toBe('line_item_price_recalculated');
      expect(mockHubspotGet).toHaveBeenCalledTimes(1);
      expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
        inputs: [{ id: '56816252584', properties: { price: '110' } }],
      });
    });

    it('skips duplicated property change events and records them as Duplicate event', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
      });
      tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
        .mockReturnValueOnce(leanResult({ _id: 'existing-event' }));

      const payload = buildPropertyChangePayload();
      const result = await lineItemPriceWebhookService.preparePayload(
        payload,
        { tenantModels, tenant }
      );

      expect(result).toEqual({
        skip: true,
        payload: null,
        executionId: null,
        meta: {
          skipped: true,
          reason: 'duplicate_event',
        },
      });
      expect(tenantModels.LineItemPriceWebhookEvent.findOne).toHaveBeenCalledWith({
        'payload.objectId': payload.objectId,
        'payload.sourceId': payload.sourceId,
        'payload.propertyValue': payload.propertyValue,
        'payload.occurredAt': payload.occurredAt,
        $or: [{ isSend: true }, { errorMessage: null }],
      });
      expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
        payload,
        isSend: false,
        errorMessage: 'Duplicate event',
      });
      expect(mockGetAccessToken).not.toHaveBeenCalled();
      expect(mockHubspotGet).not.toHaveBeenCalled();
      expect(mockBatchUpdateLineItems).not.toHaveBeenCalled();
    });

    it('processes a HubSpot retry after a previous failed attempt instead of marking it duplicate', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });
      // El registro fallido previo no matchea el filtro ($or excluye errorMessage != null),
      // por eso el findOne del duplicado resuelve null y el reintento procesa normal.
      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload({ attemptNumber: 1 }),
        { tenantModels, tenant }
      );

      expect(result.meta.reason).toBe('deal_line_items_price_recalculated');
      expect(mockBatchUpdateLineItems).toHaveBeenCalledTimes(1);
    });

    it('debounces events for a deal already processed within the configured window', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });
      tenantModels.LineItemPriceWebhookEvent.findOne = jest.fn()
        .mockReturnValueOnce(leanResult(null))
        .mockReturnValueOnce(leanResult({ _id: 'recent-execution' }));

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({});

      const payload = buildPropertyChangePayload();
      const result = await lineItemPriceWebhookService.preparePayload(
        payload,
        { tenantModels, tenant }
      );

      expect(result).toEqual({
        skip: true,
        payload: null,
        executionId: null,
        meta: {
          skipped: true,
          reason: 'debounced_event',
          dealId: '900100',
        },
      });

      const debounceFilter = tenantModels.LineItemPriceWebhookEvent.findOne.mock.calls[1][0];
      expect(debounceFilter.dealId).toBe('900100');
      expect(debounceFilter.errorMessage).toBeNull();
      expect(debounceFilter.createdAt.$gte).toBeInstanceOf(Date);

      expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
        payload,
        dealId: '900100',
        isSend: false,
        errorMessage: 'evento skipeado por envios multiples',
      });
      expect(mockBatchUpdateLineItems).not.toHaveBeenCalled();
    });

    it('recalculates every line item of the deal using each item misc value', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
        'li-2': { price: '200', safe_price_value: '200' },
        'li-3': { price: '50', miscelaneo: '50', safe_price_value: '50' },
      });

      const payload = buildPropertyChangePayload();
      const result = await lineItemPriceWebhookService.preparePayload(
        payload,
        { tenantModels, tenant }
      );

      expect(result.skip).toBe(true);
      expect(result.executionId).toBe('event-1');
      expect(result.meta).toMatchObject({
        skipped: false,
        handled: true,
        reason: 'deal_line_items_price_recalculated',
        dealId: '900100',
        requestedCount: 3,
        updatedCount: 3,
      });

      expect(mockBatchUpdateLineItems).toHaveBeenCalledTimes(1);
      expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
        inputs: [
          { id: '56816252584', properties: { price: '110' } },
          { id: 'li-2', properties: { price: '200' } },
          { id: 'li-3', properties: { price: '75' } },
        ],
      });

      expect(tenantModels.LineItemPriceWebhookEvent.create).toHaveBeenCalledWith({
        payload,
        dealId: '900100',
        isSend: false,
        errorMessage: null,
      });
      const createOrder = tenantModels.LineItemPriceWebhookEvent.create.mock.invocationCallOrder[0];
      const batchOrder = mockBatchUpdateLineItems.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(batchOrder);

      expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
        { _id: 'event-1' },
        { $set: { isSend: true, errorMessage: null } }
      );
    });

    it('excludes line items without safe_price_value from the batch update', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
        'li-2': { price: '200', miscelaneo: '5' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload(),
        { tenantModels, tenant }
      );

      expect(result.meta).toMatchObject({ requestedCount: 2, updatedCount: 1 });
      expect(mockBatchUpdateLineItems).toHaveBeenCalledWith('hubspot-token', {
        inputs: [{ id: '56816252584', properties: { price: '110' } }],
      });
    });

    it('fails when no line item has safe_price_value and records the error', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10' },
      });

      await expect(
        lineItemPriceWebhookService.preparePayload(
          buildPropertyChangePayload(),
          { tenantModels, tenant }
        )
      ).rejects.toThrow('safe_price_value is required to recalculate line item price');

      expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
        { _id: 'event-1' },
        {
          $set: {
            isSend: false,
            errorMessage: 'safe_price_value is required to recalculate line item price',
          },
        }
      );
      expect(mockBatchUpdateLineItems).not.toHaveBeenCalled();
    });

    it('does not query the debounce window when requireSkipped is false', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: false, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });

      const result = await lineItemPriceWebhookService.preparePayload(
        buildPropertyChangePayload(),
        { tenantModels, tenant }
      );

      expect(result.meta.reason).toBe('deal_line_items_price_recalculated');
      expect(tenantModels.LineItemPriceWebhookEvent.findOne).toHaveBeenCalledTimes(1);
      expect(mockBatchUpdateLineItems).toHaveBeenCalledTimes(1);
    });

    it('records the error on the created event when the HubSpot batch update fails', async () => {
      const tenantModels = buildTenantModels();
      mockConfigurationValues(tenantModels, {
        skippedInWebhooksInPropertyChange: 'SkippedVersion',
        requireSkippedInWebhooksInPropertyChange: { requireSkipped: true, secondsToSkipped: 3 },
      });

      mockGetAccessToken.mockResolvedValue('hubspot-token');
      mockDealWithLineItems({
        56816252584: { price: '100', miscelaneo: '10', safe_price_value: '100' },
      });
      mockBatchUpdateLineItems.mockRejectedValue(new Error('HubSpot batch update failed'));

      await expect(
        lineItemPriceWebhookService.preparePayload(
          buildPropertyChangePayload(),
          { tenantModels, tenant }
        )
      ).rejects.toThrow('HubSpot batch update failed');

      expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
        { _id: 'event-1' },
        { $set: { isSend: false, errorMessage: 'HubSpot batch update failed' } }
      );
    });
  });

  it('marks a processed webhook as sent', async () => {
    const LineItemPriceWebhookEvent = {
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };

    await lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, 'event-1');

    expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      {
        $set: {
          isSend: true,
          errorMessage: null,
        },
      }
    );
  });

  describe('audit persistence', () => {
    it('writes the audit in a separate updateOne from isSend/errorMessage', async () => {
      const LineItemPriceWebhookEvent = {
        updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      };

      mockLoggerWarn.mockClear();

      await lineItemPriceWebhookService.markAsError(
        LineItemPriceWebhookEvent,
        'event-1',
        new Error('HubSpot API request failed: 404 Not Found'),
        { capturedAt: 'now', calls: [] }
      );

      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledTimes(2);
      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
        1,
        { _id: 'event-1' },
        { $set: { isSend: false, errorMessage: 'HubSpot API request failed: 404 Not Found' } }
      );
      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
        2,
        { _id: 'event-1' },
        { $set: { audit: { capturedAt: 'now', calls: [] } } }
      );

      // No logger calls on successful audit write
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('does not lose errorMessage when Mongo rejects the audit write', async () => {
      const LineItemPriceWebhookEvent = {
        updateOne: jest.fn()
          .mockResolvedValueOnce({ acknowledged: true })
          .mockRejectedValueOnce(new Error("The dollar ($) prefixed field '$select' is not valid for storage")),
      };

      mockLoggerWarn.mockClear();

      await expect(
        lineItemPriceWebhookService.markAsError(
          LineItemPriceWebhookEvent,
          'event-1',
          new Error('boom'),
          { calls: [] }
        )
      ).resolves.toBeUndefined();

      // Verify the status write happened first
      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
        1,
        { _id: 'event-1' },
        { $set: { isSend: false, errorMessage: 'boom' } }
      );

      // Verify the second updateOne call happened (the audit write that rejected)
      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledTimes(2);
      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenNthCalledWith(
        2,
        { _id: 'event-1' },
        { $set: { audit: { calls: [] } } }
      );

      // Verify the catch branch fired and logged the warning
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'Line item price audit could not be persisted',
          executionId: 'event-1',
          error: "The dollar ($) prefixed field '$select' is not valid for storage",
        })
      );
    });

    it('skips the audit write when there is no audit', async () => {
      const LineItemPriceWebhookEvent = {
        updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      };

      await lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, 'event-1');

      expect(LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledTimes(1);
    });
  });
});
