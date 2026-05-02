import { jest } from '@jest/globals';

const mockRequireTenantModels = jest.fn();
const mockSyncScheduledJob = jest.fn();

jest.unstable_mockModule('../../src/utils/tenantModels.js', () => ({
  requireTenantModels: mockRequireTenantModels,
}));

jest.unstable_mockModule('../../src/services/scheduler/sapSyncScheduler.service.js', () => ({
  syncScheduledJob: mockSyncScheduledJob,
}));

const { createClientConfig } = await import('../../src/controllers/config.controller.js');
const { buildServiceLayerUrl } = await import('../../src/services/serviceLayerUrlBuilder.js');

describe('SERVICE_LAYER configuration flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates client config with generated apiUrl for SERVICE_LAYER mode', async () => {
    const createdPayload = {
      _id: 'cfg-1',
    };

    const ClientConfig = {
      create: jest.fn().mockResolvedValue(createdPayload),
    };

    const IntegrationMode = {
      exists: jest.fn().mockResolvedValue(true),
    };

    const SapFilter = {
      find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    };
    const FieldMapping = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ _id: 'map-1' }),
    };

    mockRequireTenantModels.mockReturnValue({ ClientConfig, FieldMapping, IntegrationMode, SapFilter });

    const req = {
      body: {
        clientName: 'Obtener Clientes',
        integrationModeId: 'mode-id',
        objectType: 'contact',
        intervalMinutes: 5,
        serviceLayerBaseUrl: 'https://201.7.208.10:23052/',
        serviceLayerPath: 'BusinessPartners',
        serviceLayerUsername: 'manager',
        serviceLayerPassword: 'secret',
        apiUrl: 'https://malicious.example/odata',
      },
    };

    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn((payload) => payload),
    };

    await createClientConfig(req, reply);

    expect(ClientConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceLayerBaseUrl: 'https://201.7.208.10:23052/',
        serviceLayerPath: 'BusinessPartners',
        apiUrl: 'https://malicious.example/odata',
        filters: [],
      })
    );

    expect(reply.send).toHaveBeenCalledWith({
      ok: true,
      data: createdPayload,
    });
  });

  it('creates contactEmployee defaults only for company configs', async () => {
    const createdCompanyConfig = {
      _id: 'cfg-company',
      objectType: 'company',
      hubspotCredentialId: 'cred-1',
    };

    const createdContactConfig = {
      _id: 'cfg-contact',
      objectType: 'contact',
      hubspotCredentialId: 'cred-1',
    };

    const ClientConfig = {
      create: jest
        .fn()
        .mockResolvedValueOnce(createdCompanyConfig)
        .mockResolvedValueOnce(createdContactConfig),
    };

    const FieldMapping = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ _id: 'map-1' }),
    };

    const IntegrationMode = {
      exists: jest.fn().mockResolvedValue(true),
    };

    const SapFilter = {
      find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    };

    mockRequireTenantModels.mockReturnValue({ ClientConfig, FieldMapping, IntegrationMode, SapFilter });

    const reply = { code: jest.fn().mockReturnThis(), send: jest.fn((payload) => payload) };

    await createClientConfig(
      {
        body: {
          integrationModeId: 'mode-id',
          objectType: 'company',
          hubspotCredentialId: 'cred-1',
        },
      },
      reply
    );

    await createClientConfig(
      {
        body: {
          integrationModeId: 'mode-id',
          objectType: 'contact',
          hubspotCredentialId: 'cred-1',
        },
      },
      reply
    );

    expect(FieldMapping.findOne).toHaveBeenCalledTimes(15);
    expect(FieldMapping.create).toHaveBeenCalledTimes(15);
    expect(FieldMapping.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'contact',
        sourceContext: 'contactEmployee',
        clientConfigId: 'cfg-company',
      })
    );
    expect(FieldMapping.findOne).not.toHaveBeenCalledWith(
      expect.objectContaining({
        clientConfigId: 'cfg-contact',
      })
    );
  });

  it('rejects SERVICE_LAYER config when required fields are missing', async () => {
    mockRequireTenantModels.mockReturnValue({
      ClientConfig: { create: jest.fn() },
      FieldMapping: { findOne: jest.fn(), create: jest.fn() },
      IntegrationMode: { exists: jest.fn().mockResolvedValue(true) },
      SapFilter: { find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) },
    });

    const reply = { code: jest.fn().mockReturnThis(), send: jest.fn((payload) => payload) };

    await createClientConfig(
      {
        body: {
          integrationModeId: 'mode-id',
          serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        },
      },
      reply
    );

    expect(reply.send).toHaveBeenCalledWith({ ok: true, data: undefined });
  });

  it('builds a sanitized $select URL from mappings', () => {
    const url = buildServiceLayerUrl(
      {
        integrationModeName: 'SERVICE_LAYER',
        serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        serviceLayerPath: '/BusinessPartners?hack=true',
      },
      [
        { sourceField: 'CardCode' },
        { sourceField: 'CardName' },
        { sourceField: 'CardName' },
        { sourceField: 'EmailAddress' },
        { sourceField: 'CardName desc' },
      ]
    );

    expect(url).toBe(
      'https://201.7.208.10:23052/b1s/v2/BusinessPartners?$select=CardCode,CardName,EmailAddress'
    );
  });

  it('builds $filter automatically from clientConfig.filters', () => {
    const url = buildServiceLayerUrl(
      {
        integrationModeName: 'SERVICE_LAYER',
        serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        serviceLayerPath: '/BusinessPartners',
        intervalMinutes: 60,
        filters: [
          { property: 'CardType', operator: 'eq', value: 'C' },
          { property: 'UpdateDate', operator: 'ge', value: '2026-02-27T18:30:00' },
        ],
      },
      [{ sourceField: 'CardCode' }],
      { controlledFilter: "CardType eq 'S'" }
    );

    expect(url).toBe(
      "https://201.7.208.10:23052/b1s/v2/BusinessPartners?$select=CardCode&$filter=CardType%20eq%20'C'%20and%20UpdateDate%20ge%202026-02-27T18%3A30%3A00%20and%20CardType%20eq%20'S'"
    );
  });

  it('builds dynamic ge filter using intervalMinutes', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-27T19:30:00.000Z'));

    const url = buildServiceLayerUrl(
      {
        integrationModeName: 'SERVICE_LAYER',
        serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        serviceLayerPath: '/BusinessPartners',
        intervalMinutes: 60,
        filters: [{ property: 'UpdateDate', operator: 'ge', isDynamic: true, value: null }],
      },
      [{ sourceField: 'CardCode' }]
    );

    expect(url).toContain('$filter=UpdateDate%20ge%202026-02-27T18%3A30%3A00');
    jest.useRealTimers();
  });


  it('builds startswith and not_startswith filters in OData syntax', () => {
    const companyUrl = buildServiceLayerUrl(
      {
        integrationModeName: 'SERVICE_LAYER',
        serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        serviceLayerPath: '/BusinessPartners',
        filters: [
          { property: 'CardType', operator: 'eq', value: 'C' },
          { property: 'FederalTaxID', operator: 'startswith', value: 'J' },
          { property: 'UpdateDate', operator: 'ge', value: '2024-01-01' },
        ],
      },
      [{ sourceField: 'CardCode' }]
    );

    expect(companyUrl).toContain("$filter=CardType%20eq%20'C'%20and%20startswith(FederalTaxID%2C'J')%20and%20UpdateDate%20ge%202024-01-01");

    const contactUrl = buildServiceLayerUrl(
      {
        integrationModeName: 'SERVICE_LAYER',
        serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        serviceLayerPath: '/BusinessPartners',
        filters: [
          { property: 'CardType', operator: 'eq', value: 'C' },
          { property: 'FederalTaxID', operator: 'not_startswith', value: 'J' },
          { property: 'UpdateDate', operator: 'ge', value: '2024-01-01' },
        ],
      },
      [{ sourceField: 'CardCode' }]
    );

    expect(contactUrl).toContain("$filter=CardType%20eq%20'C'%20and%20not%20startswith(FederalTaxID%2C'J')%20and%20UpdateDate%20ge%202024-01-01");
  });


  it('appends company additional fields from env into $select', () => {
    process.env.COMPANY_ADD_FIELDS_URL_SAP = 'BPAddresses,ContactEmployees';

    const url = buildServiceLayerUrl(
      {
        integrationModeName: 'SERVICE_LAYER',
        objectType: 'company',
        serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        serviceLayerPath: '/BusinessPartners',
      },
      [{ sourceField: 'CardCode' }, { sourceField: 'CardName' }]
    );

    expect(url).toBe(
      'https://201.7.208.10:23052/b1s/v2/BusinessPartners?$select=CardCode,CardName,BPAddresses,ContactEmployees'
    );

    delete process.env.COMPANY_ADD_FIELDS_URL_SAP;
  });

  it('throws when filter has invalid operator', () => {
    expect(() =>
      buildServiceLayerUrl(
        {
          integrationModeName: 'SERVICE_LAYER',
          serviceLayerBaseUrl: 'https://201.7.208.10:23052',
          serviceLayerPath: '/BusinessPartners',
          filters: [{ property: 'CardType', operator: 'ne', value: 'C' }],
        },
        [{ sourceField: 'CardCode' }]
      )
    ).toThrow('Unsupported SAP filter operator: ne');
  });

});
