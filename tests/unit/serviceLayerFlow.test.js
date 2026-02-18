import { jest } from '@jest/globals';

const mockRequireTenantModels = jest.fn();

jest.unstable_mockModule('../../src/utils/tenantModels.js', () => ({
  requireTenantModels: mockRequireTenantModels,
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
      findById: jest.fn().mockResolvedValue({ name: 'SERVICE_LAYER' }),
    };

    mockRequireTenantModels.mockReturnValue({ ClientConfig, IntegrationMode });

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
      send: jest.fn((payload) => payload),
    };

    await createClientConfig(req, reply);

    expect(ClientConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        serviceLayerPath: '/BusinessPartners',
        apiUrl: 'https://201.7.208.10:23052/b1s/v2/BusinessPartners',
        apiToken: null,
      })
    );

    expect(reply.send).toHaveBeenCalledWith({
      ok: true,
      data: createdPayload,
    });
  });

  it('rejects SERVICE_LAYER config when required fields are missing', async () => {
    mockRequireTenantModels.mockReturnValue({
      ClientConfig: { create: jest.fn() },
      IntegrationMode: { findById: jest.fn().mockResolvedValue({ name: 'SERVICE_LAYER' }) },
    });

    const reply = { send: jest.fn((payload) => payload) };

    await createClientConfig(
      {
        body: {
          integrationModeId: 'mode-id',
          serviceLayerBaseUrl: 'https://201.7.208.10:23052',
        },
      },
      reply
    );

    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      message:
        'SERVICE_LAYER mode requires serviceLayerBaseUrl, serviceLayerPath, serviceLayerUsername and serviceLayerPassword',
    });
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
});
