import { jest } from '@jest/globals';

const mockAxios = jest.fn();
const mockGetMappingsByObjectType = jest.fn();
const mockGetAccessToken = jest.fn();
const mockUpdateDeal = jest.fn();
const mockUpdateCompany = jest.fn();
const mockUpdateContact = jest.fn();
const mockGetSessionCookie = jest.fn();
const mockInvalidateSession = jest.fn();
const mockResolveTenantKey = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

jest.unstable_mockModule('../../src/services/mapping.service.js', () => ({
  default: {
    getMappingsByObjectType: mockGetMappingsByObjectType,
  },
}));

jest.unstable_mockModule('../../src/services/hubspotAuthService.js', () => ({
  default: {
    getAccessToken: mockGetAccessToken,
  },
}));

jest.unstable_mockModule('../../src/services/hubspotClient.js', () => ({
  updateDeal: mockUpdateDeal,
  updateCompany: mockUpdateCompany,
  updateContact: mockUpdateContact,
}));

jest.unstable_mockModule('../../src/services/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: mockGetSessionCookie,
    invalidateSession: mockInvalidateSession,
    resolveTenantKey: mockResolveTenantKey,
  },
  isSessionInvalidError: (error) => [401, 403].includes(error?.response?.status),
}));

jest.unstable_mockModule('../../src/core/logger.js', () => ({
  default: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

const webhookProcessor = (await import('../../src/services/webhookProcessor.js')).default;

function createLeanQuery(value) {
  return {
    lean: jest.fn().mockResolvedValue(value),
    sort: jest.fn().mockReturnThis(),
  };
}

function buildTenantModels({
  configurationValue = '4',
  portalId = '12345',
  company = null,
  contact = null,
  lineItems = null,
} = {}) {
  const event = {
    _id: 'evt-1',
    status: 'waiting',
    retries: 0,
    maxRetries: 3,
    payload: {
      portalId,
      deal: {
        hs_object_id: 'deal-1',
      },
      company,
      contact,
      line_items: lineItems || [
        {
          hs_sku: 'SKU-1',
          quantity: 2,
          price: 30,
        },
      ],
    },
  };

  const leanEvent = jest.fn()
    .mockResolvedValueOnce(event)
    .mockResolvedValueOnce(null);

  return {
    HubspotCredentials: {
      findOne: jest.fn()
        .mockReturnValueOnce(createLeanQuery({
          _id: 'hubspot-credential-1',
          clientConfigId: 'client-config-1',
          portalId,
        })),
    },
    SapCredentials: {
      findOne: jest.fn().mockReturnValue(createLeanQuery({
        clientConfigId: 'client-config-1',
        serviceLayerBaseUrl: 'https://sap.example.com:50000',
      })),
    },
    Configuration: {
      findOneAndUpdate: jest.fn().mockResolvedValue({
        key: 'priceList',
        value: configurationValue,
        userUpdated: 'admin',
      }),
    },
    WebhookEvent: {
      findOneAndUpdate: jest.fn(() => ({ lean: leanEvent })),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    },
  };
}

function setupMappings() {
  mockGetMappingsByObjectType
    .mockResolvedValueOnce([
      { sourceField: 'CardName', targetField: 'name' },
      { sourceField: 'EmailAddress', targetField: 'email' },
      { sourceField: 'Phone1', targetField: 'phone' },
      { sourceField: 'PriceListNum', targetField: 'priceListNum' },
      { sourceField: 'CardCode', targetField: 'idsap' },
    ])
    .mockResolvedValueOnce([
      { sourceField: 'CardName', targetField: 'firstname' },
      { sourceField: 'EmailAddress', targetField: 'email' },
      { sourceField: 'Phone1', targetField: 'phone' },
      { sourceField: 'PriceListNum', targetField: 'priceListNum' },
      { sourceField: 'CardCode', targetField: 'idsap' },
    ])
    .mockResolvedValueOnce([
      { sourceField: 'Name', targetField: 'firstname' },
      { sourceField: 'E_Mail', targetField: 'email' },
    ])
    .mockResolvedValueOnce([
      { sourceField: 'ItemCode', targetField: 'hs_sku' },
      { sourceField: 'Quantity', targetField: 'quantity' },
      { sourceField: 'UnitPrice', targetField: 'price' },
    ])
    .mockResolvedValueOnce([
      { sourceField: 'DocEntry', targetField: 'sap_docentry' },
      { sourceField: 'DocNum', targetField: 'sap_docnum' },
    ]);
}

describe('webhookProcessor flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxios.mockReset();
    mockGetMappingsByObjectType.mockReset();
    mockGetAccessToken.mockReset();
    mockUpdateDeal.mockReset();
    mockUpdateCompany.mockReset();
    mockUpdateContact.mockReset();
    mockGetSessionCookie.mockReset();
    mockInvalidateSession.mockReset();
    mockResolveTenantKey.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerError.mockReset();

    mockGetSessionCookie.mockResolvedValue({ cookie: 'B1SESSION=abc' });
    mockResolveTenantKey.mockReturnValue('tenant_1');
    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockUpdateDeal.mockResolvedValue({ id: 'deal-1' });
    mockUpdateCompany.mockResolvedValue({ id: 'company-1' });
    mockUpdateContact.mockResolvedValue({ id: 'contact-1' });
  });

  it('uses tenant priceList config when payload does not send PriceListNum', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      company: {
        hs_object_id: 'company-1',
        name: 'ACME',
        email: 'ventas@acme.com',
        phone: '555-1111',
      },
    });

    mockAxios
      .mockResolvedValueOnce({
        data: { value: [] },
      })
      .mockResolvedValueOnce({
        data: { CardCode: 'C20000' },
      })
      .mockResolvedValueOnce({
        data: {
          CardCode: 'C20000',
          CardName: 'ACME',
          EmailAddress: 'ventas@acme.com',
          PriceListNum: 4,
          ContactEmployees: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          DocEntry: 10,
          DocNum: 20,
        },
      });

    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: 'tenant-1',
      tenantKey: 'tenant_1',
      portalId: '12345',
    });

    expect(result.completed).toBe(1);
    expect(mockAxios).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/BusinessPartners',
        data: expect.objectContaining({
          CardCode: expect.stringMatching(/^CL/),
          CardName: 'ACME',
          PriceListNum: 4,
        }),
      })
    );
    expect(tenantModels.Configuration.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'priceList' },
      {
        $setOnInsert: {
          key: 'priceList',
          value: null,
          userUpdated: 'admin',
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  });

  it('errors when neither HubSpot nor tenant config provides PriceListNum', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      configurationValue: null,
      company: {
        hs_object_id: 'company-1',
        name: 'ACME',
        email: 'ventas@acme.com',
      },
    });

    mockAxios.mockResolvedValueOnce({
      data: { value: [] },
    });

    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: 'tenant-1',
      tenantKey: 'tenant_1',
      portalId: '12345',
    });

    expect(result.completed).toBe(0);
    expect(result.errored).toBe(1);
    expect(tenantModels.WebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'evt-1' },
      {
        $set: {
          status: 'errored',
          retries: 3,
          lastError: 'PriceListNum is required from HubSpot mapping or tenant configuration priceList',
        },
      }
    );
  });

  it('updates HubSpot idsap when SAP partner exists by email and contact arrives without sapId', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Mario',
        email: 'mario@example.com',
      },
    });

    mockAxios
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              CardCode: 'C30000',
              CardName: 'Mario',
              EmailAddress: 'mario@example.com',
              PriceListNum: 4,
              ContactEmployees: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          DocEntry: 11,
          DocNum: 21,
        },
      });

    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: 'tenant-1',
      tenantKey: 'tenant_1',
      portalId: '12345',
    });

    expect(result.completed).toBe(1);
    expect(mockUpdateContact).toHaveBeenCalledWith('hubspot-token', 'contact-1', {
      properties: {
        idsap: 'C30000',
      },
    });
    expect(mockUpdateCompany).not.toHaveBeenCalled();
  });

  it('creates SAP partner without email and writes idsap back to HubSpot', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Lucia',
      },
    });

    mockAxios.mockImplementation(async (config) => {
      if (config.method === 'post' && config.url.endsWith('/b1s/v2/BusinessPartners')) {
        return { data: {} };
      }

      if (config.method === 'get' && config.url.includes("/b1s/v2/BusinessPartners('")) {
        const cardCode = decodeURIComponent(
          config.url.split("/b1s/v2/BusinessPartners('")[1].split("')")[0]
        );

        return {
          data: {
            CardCode: cardCode,
            CardName: 'Lucia',
            PriceListNum: 4,
            ContactEmployees: [],
          },
        };
      }

      if (config.method === 'post' && config.url.endsWith('/b1s/v2/Orders')) {
        return {
          data: {
            DocEntry: 12,
            DocNum: 22,
          },
        };
      }

      throw new Error(`Unexpected axios call: ${config.method} ${config.url}`);
    });

    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: 'tenant-1',
      tenantKey: 'tenant_1',
      portalId: '12345',
    });

    expect(result.completed).toBe(1);
    expect(mockAxios).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/BusinessPartners',
        data: expect.objectContaining({
          CardCode: expect.stringMatching(/^CL/),
          CardName: 'Lucia',
          EmailAddress: '',
          PriceListNum: 4,
        }),
      })
    );
    expect(mockUpdateContact).toHaveBeenCalledWith('hubspot-token', 'contact-1', {
      properties: {
        idsap: expect.stringMatching(/^CL/),
      },
    });
  });

  it('writes idsap back to HubSpot before order creation completes', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Lucia',
      },
    });

    mockAxios.mockImplementation(async (config) => {
      if (config.method === 'post' && config.url.endsWith('/b1s/v2/BusinessPartners')) {
        return { data: {} };
      }

      if (config.method === 'get' && config.url.includes("/b1s/v2/BusinessPartners('")) {
        const cardCode = decodeURIComponent(
          config.url.split("/b1s/v2/BusinessPartners('")[1].split("')")[0]
        );

        return {
          data: {
            CardCode: cardCode,
            CardName: 'Lucia',
            PriceListNum: 4,
            ContactEmployees: [],
          },
        };
      }

      if (config.method === 'post' && config.url.endsWith('/b1s/v2/Orders')) {
        throw new Error('Order create failed');
      }

      throw new Error(`Unexpected axios call: ${config.method} ${config.url}`);
    });

    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: 'tenant-1',
      tenantKey: 'tenant_1',
      portalId: '12345',
    });

    expect(result.completed).toBe(0);
    expect(result.retried).toBe(1);
    expect(mockUpdateContact).toHaveBeenCalledWith('hubspot-token', 'contact-1', {
      properties: {
        idsap: expect.stringMatching(/^CL/),
      },
    });
  });
});
