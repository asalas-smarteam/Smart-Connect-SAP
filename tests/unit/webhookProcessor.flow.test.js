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
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

jest.unstable_mockModule('../../src/infrastructure/database/repositories/mapping.service.js', () => ({
  default: {
    getMappingsByObjectType: mockGetMappingsByObjectType,
  },
}));

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotAuthService.js', () => ({
  default: {
    getAccessToken: mockGetAccessToken,
  },
}));

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  updateDeal: mockUpdateDeal,
  updateCompany: mockUpdateCompany,
  updateContact: mockUpdateContact,
}));

jest.unstable_mockModule('../../src/infrastructure/sap/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: mockGetSessionCookie,
    invalidateSession: mockInvalidateSession,
    resolveTenantKey: mockResolveTenantKey,
  },
  isSessionInvalidError: (error) => [401, 403].includes(error?.response?.status),
}));

jest.unstable_mockModule('../../src/infrastructure/logger/logger.js', () => ({
  default: {
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: mockLoggerWarn,
  },
}));

const webhookProcessor = (await import('../../src/infrastructure/webhook/webhookProcessor.js')).default;

function createLeanQuery(value) {
  return {
    lean: jest.fn().mockResolvedValue(value),
    sort: jest.fn().mockReturnThis(),
  };
}

function buildTenantModels({
  configurationValue = '4',
  requireRandCardCodeValue = true,
  defaultSeriesValue = null,
  defaultFindSAPValue = 'EmailAddress',
  groupCodeDefaultsValue = null,
  taxCodesValue = [],
  portalId = '12345',
  company = null,
  contact = null,
  lineItems = null,
  deal = {},
  ownerMapping = null,
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
        ...deal,
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
      findOne: jest.fn().mockImplementation((filter) => {
        if (filter?.key === 'groupCodeDefauls' && groupCodeDefaultsValue) {
          return createLeanQuery({
            key: 'groupCodeDefauls',
            value: groupCodeDefaultsValue,
            userUpdated: 'admin',
          });
        }

        return createLeanQuery(null);
      }),
      findOneAndUpdate: jest.fn().mockImplementation(async (filter) => {
        if (filter?.key === 'priceList') {
          return {
            key: 'priceList',
            value: configurationValue,
            userUpdated: 'admin',
          };
        }

        if (filter?.key === 'taxCodes') {
          return {
            key: 'taxCodes',
            value: taxCodesValue,
            userUpdated: 'admin',
          };
        }

        if (filter?.key === 'requireRandCardCode') {
          return {
            key: 'requireRandCardCode',
            value: requireRandCardCodeValue,
            userUpdated: 'admin',
          };
        }

        if (filter?.key === 'defaultSeries') {
          return {
            key: 'defaultSeries',
            value: defaultSeriesValue,
            userUpdated: 'admin',
          };
        }

        if (filter?.key === 'defaultFindSAP') {
          return {
            key: 'defaultFindSAP',
            value: defaultFindSAPValue,
            userUpdated: 'admin',
          };
        }

        return null;
      }),
    },
    WebhookEvent: {
      findOneAndUpdate: jest.fn(() => ({ lean: leanEvent })),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    },
    OwnerMapping: {
      findOne: jest.fn().mockReturnValue(createLeanQuery(ownerMapping)),
    },
  };
}

function setupMappings({ ordersQuotationsMappings = [] } = {}) {
  mockGetMappingsByObjectType
    .mockResolvedValueOnce([
      { sourceField: 'CardName', targetField: 'name' },
      { sourceField: 'EmailAddress', targetField: 'email' },
      { sourceField: 'Phone1', targetField: 'phone' },
      { sourceField: 'PriceListNum', targetField: 'priceListNum' },
      { sourceField: 'CardCode', targetField: 'idsap' },
      { sourceField: 'FederalTaxID', targetField: 'ruc' },
    ])
    .mockResolvedValueOnce([
      { sourceField: 'CardName', targetField: 'firstname' },
      { sourceField: 'EmailAddress', targetField: 'email' },
      { sourceField: 'Phone1', targetField: 'phone' },
      { sourceField: 'PriceListNum', targetField: 'priceListNum' },
      { sourceField: 'CardCode', targetField: 'idsap' },
      { sourceField: 'FederalTaxID', targetField: 'dni' },
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
    ])
    .mockResolvedValueOnce(ordersQuotationsMappings);
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
    mockLoggerWarn.mockReset();

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

  it('sends TaxCode in SAP order lines using tenant taxCodes config and hs_tax_rate', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      taxCodesValue: [
        { Rate: 15, Name: 'Impuesto al Valor', Code: 'IVA', HSCode: '17493851' },
        { Rate: 0, Name: 'Exento de Impuesto', Code: 'EXE', HSCode: '17571233' },
      ],
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Cliente Mostrador',
        idsap: 'CL99999',
      },
      lineItems: [
        {
          hs_sku: 'A56010004',
          quantity: '1',
          price: '19.21',
          hs_tax_rate: '15.0000',
          warehouses: 'B04',
        },
      ],
    });

    mockAxios
      .mockResolvedValueOnce({
        data: {
          CardCode: 'CL99999',
          CardName: 'Cliente Mostrador',
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
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/Orders',
        data: expect.objectContaining({
          CardCode: 'CL99999',
          DocumentLines: [
            {
              ItemCode: 'A56010004',
              Quantity: 1,
              UnitPrice: 19.21,
              WarehouseCode: 'B04',
              TaxCode: 'IVA',
            },
          ],
        }),
      })
    );
  });

  it('sends SAP SalesPersonCode in the order payload from the HubSpot owner mapping', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      deal: {
        hubspot_owner_id: '82088708',
      },
      ownerMapping: {
        sapOwnerId: '5',
      },
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Cliente Mostrador',
        idsap: 'CL99999',
      },
    });

    mockAxios
      .mockResolvedValueOnce({
        data: {
          CardCode: 'CL99999',
          CardName: 'Cliente Mostrador',
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
    expect(tenantModels.OwnerMapping.findOne).toHaveBeenCalledWith({
      hubspotCredentialId: 'hubspot-credential-1',
      hubspotOwnerId: '82088708',
      active: true,
    });
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/Orders',
        data: expect.objectContaining({
          CardCode: 'CL99999',
          SalesPersonCode: 5,
        }),
      })
    );
  });

  it('sends PaymentGroupCode in the SAP order payload from the orders-quotations deal mapping', async () => {
    setupMappings({
      ordersQuotationsMappings: [
        { sourceField: 'PaymentGroupCode', targetField: 'paymentGroupCode' },
      ],
    });
    const tenantModels = buildTenantModels({
      deal: {
        paymentGroupCode: '3',
      },
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Cliente Mostrador',
        idsap: 'CL99999',
      },
    });

    mockAxios
      .mockResolvedValueOnce({
        data: {
          CardCode: 'CL99999',
          CardName: 'Cliente Mostrador',
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
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/Orders',
        data: expect.objectContaining({
          CardCode: 'CL99999',
          PaymentGroupCode: 3,
        }),
      })
    );
  });

  it('falls back to groupCodeDefauls config for PaymentGroupCode and PayTermsGrpCode', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      groupCodeDefaultsValue: { PayTermsGrpCode: 2, PaymentGroupCode: 2 },
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
            DocEntry: 16,
            DocNum: 26,
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
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/BusinessPartners',
        data: expect.objectContaining({
          CardName: 'Lucia',
          PayTermsGrpCode: 2,
        }),
      })
    );
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/Orders',
        data: expect.objectContaining({
          PaymentGroupCode: 2,
        }),
      })
    );
  });

  it('omits PaymentGroupCode and PayTermsGrpCode when no mapping or config default exists', async () => {
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
            DocEntry: 17,
            DocNum: 27,
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

    const businessPartnerRequest = mockAxios.mock.calls
      .map(([config]) => config)
      .find((config) => config.method === 'post' && config.url.endsWith('/b1s/v2/BusinessPartners'));
    const orderRequest = mockAxios.mock.calls
      .map(([config]) => config)
      .find((config) => config.method === 'post' && config.url.endsWith('/b1s/v2/Orders'));

    expect(result.completed).toBe(1);
    expect(businessPartnerRequest.data).not.toHaveProperty('PayTermsGrpCode');
    expect(orderRequest.data).not.toHaveProperty('PaymentGroupCode');
  });

  it('omits SAP SalesPersonCode and logs a warning when the HubSpot owner mapping is missing', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      deal: {
        hubspot_owner_id: '82088708',
      },
      ownerMapping: null,
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Cliente Mostrador',
        idsap: 'CL99999',
      },
    });

    mockAxios
      .mockResolvedValueOnce({
        data: {
          CardCode: 'CL99999',
          CardName: 'Cliente Mostrador',
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

    const orderRequest = mockAxios.mock.calls
      .map(([config]) => config)
      .find((config) => config.method === 'post' && config.url.endsWith('/b1s/v2/Orders'));

    expect(result.completed).toBe(1);
    expect(orderRequest.data).not.toHaveProperty('SalesPersonCode');
    expect(mockLoggerWarn).toHaveBeenCalledWith({
      msg: 'SAP owner mapping not found for HubSpot owner',
      hubspotOwnerId: '82088708',
      dealId: 'deal-1',
    });
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

  it('omits CardCode when tenant disables generated card codes and writes SAP response CardCode to HubSpot', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      requireRandCardCodeValue: false,
      defaultSeriesValue: 73,
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Lucia',
      },
    });

    mockAxios.mockImplementation(async (config) => {
      if (config.method === 'post' && config.url.endsWith('/b1s/v2/BusinessPartners')) {
        return { data: { CardCode: 'AUTO100' } };
      }

      if (config.method === 'get' && config.url.includes("/b1s/v2/BusinessPartners('AUTO100')")) {
        return {
          data: {
            CardCode: 'AUTO100',
            CardName: 'Lucia',
            PriceListNum: 4,
            ContactEmployees: [],
          },
        };
      }

      if (config.method === 'post' && config.url.endsWith('/b1s/v2/Orders')) {
        return {
          data: {
            DocEntry: 14,
            DocNum: 24,
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

    const businessPartnerRequest = mockAxios.mock.calls
      .map(([config]) => config)
      .find((config) => config.method === 'post' && config.url.endsWith('/b1s/v2/BusinessPartners'));

    expect(result.completed).toBe(1);
    expect(businessPartnerRequest.data).not.toHaveProperty('CardCode');
    expect(businessPartnerRequest.data).toHaveProperty('Series', 73);
    expect(mockUpdateContact).toHaveBeenCalledWith('hubspot-token', 'contact-1', {
      properties: {
        idsap: 'AUTO100',
      },
    });
  });

  it('finds existing SAP partner with configured defaultFindSAP field and writes idsap back to HubSpot', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      defaultFindSAPValue: 'Phone1',
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Mario',
        phone: '+50587365564',
      },
    });

    mockAxios
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              CardCode: 'C30001',
              CardName: 'Mario',
              Phone1: '+50587365564',
              PriceListNum: 4,
              ContactEmployees: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          DocEntry: 15,
          DocNum: 25,
        },
      });

    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: 'tenant-1',
      tenantKey: 'tenant_1',
      portalId: '12345',
    });

    expect(result.completed).toBe(1);
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://sap.example.com:50000/b1s/v2/BusinessPartners',
        params: expect.objectContaining({
          $select: 'CardCode,CardName,EmailAddress,Phone1,PriceListNum,ContactEmployees',
          $filter: "Phone1 eq '+50587365564'",
        }),
      })
    );
    expect(mockUpdateContact).toHaveBeenCalledWith('hubspot-token', 'contact-1', {
      properties: {
        idsap: 'C30001',
      },
    });
  });

  it('uses contact dni as FederalTaxID when the Business Partner is created from contact only', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Linda',
        lastname: 'Gutierrez',
        email: 'mercadeo@ferreterianoelito.com',
        phone: '+50587365564',
        dni: '161-190300-1004C',
      },
    });

    mockAxios.mockImplementation(async (config) => {
      if (config.method === 'get' && config.url.endsWith('/b1s/v2/BusinessPartners')) {
        return { data: { value: [] } };
      }

      if (config.method === 'post' && config.url.endsWith('/b1s/v2/BusinessPartners')) {
        return { data: { CardCode: config.data.CardCode } };
      }

      if (config.method === 'get' && config.url.includes("/b1s/v2/BusinessPartners('")) {
        const cardCode = decodeURIComponent(
          config.url.split("/b1s/v2/BusinessPartners('")[1].split("')")[0]
        );

        return {
          data: {
            CardCode: cardCode,
            CardName: 'Linda',
            EmailAddress: 'mercadeo@ferreterianoelito.com',
            PriceListNum: 4,
            ContactEmployees: [],
          },
        };
      }

      if (config.method === 'post' && config.url.endsWith('/b1s/v2/Orders')) {
        return {
          data: {
            DocEntry: 13,
            DocNum: 23,
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
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/BusinessPartners',
        data: expect.objectContaining({
          CardName: 'Linda',
          CompanyPrivate: 'I',
          EmailAddress: 'mercadeo@ferreterianoelito.com',
          Phone1: '+50587365564',
          FederalTaxID: '161-190300-1004C',
        }),
      })
    );
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

  it('keeps SAP order creation from being retried when HubSpot update fails afterward', async () => {
    setupMappings();
    const tenantModels = buildTenantModels({
      contact: {
        hs_object_id: 'contact-1',
        firstname: 'Cliente Mostrador',
        idsap: 'CL99999',
      },
    });

    mockAxios
      .mockResolvedValueOnce({
        data: {
          CardCode: 'CL99999',
          CardName: 'Cliente Mostrador',
          PriceListNum: 4,
          ContactEmployees: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          DocEntry: 99,
          DocNum: 199,
        },
      });
    mockUpdateDeal.mockRejectedValue(new Error('HubSpot update failed'));

    const result = await webhookProcessor.processPendingEvents({
      tenantModels,
      tenantId: 'tenant-1',
      tenantKey: 'tenant_1',
      portalId: '12345',
    });

    expect(result.completed).toBe(0);
    expect(result.retried).toBe(0);
    expect(result.errored).toBe(1);
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://sap.example.com:50000/b1s/v2/Orders',
      })
    );
    expect(tenantModels.WebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'evt-1' },
      {
        $set: expect.objectContaining({
          status: 'sap_order_created',
          lastError: null,
          'payload.sapResult': {
            cardCode: 'CL99999',
            docEntry: 99,
            docNum: 199,
          },
          'payload.payloadSAP': expect.objectContaining({
            CardCode: 'CL99999',
          }),
        }),
      }
    );
    expect(tenantModels.WebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'evt-1' },
      {
        $set: {
          status: 'sap_created_hubspot_error',
          retries: 0,
          lastError: 'HubSpot update failed',
          'payload.sapResult': {
            cardCode: 'CL99999',
            docEntry: 99,
            docNum: 199,
          },
          'payload.payloadSAP': expect.objectContaining({
            CardCode: 'CL99999',
          }),
        },
      }
    );
  });
});
