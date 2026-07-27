import { jest } from '@jest/globals';

const mockServiceLayerExecute = jest.fn();
const mockS4Execute = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/sap/serviceLayer.service.js', () => ({
  default: { execute: mockServiceLayerExecute },
}));

jest.unstable_mockModule('../../../src/infrastructure/sap/s4ODataService.js', () => ({
  default: { execute: mockS4Execute },
}));

jest.unstable_mockModule('../../../src/infrastructure/sap/modes/spMode.js', () => ({
  default: { execute: jest.fn() },
}));
jest.unstable_mockModule('../../../src/infrastructure/sap/modes/scriptMode.js', () => ({
  default: { execute: jest.fn() },
}));
jest.unstable_mockModule('../../../src/infrastructure/sap/modes/apiMode.js', () => ({
  default: { execute: jest.fn() },
}));
jest.unstable_mockModule('../../../src/infrastructure/logger/logger.adapter.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { SapSyncDataAdapter } = await import(
  '../../../src/infrastructure/sap/SapSyncDataAdapter.js'
);

function buildTenantModels(integrationModeName, credentials = [{ serviceLayerBaseUrl: 'https://sap' }]) {
  const config = {
    _id: 'config-1',
    serviceLayerPath: '/Whatever',
    integrationModeId: { name: integrationModeName },
    toObject() { return { _id: 'config-1', serviceLayerPath: '/Whatever' }; },
  };

  return {
    ClientConfig: {
      findById: () => ({ populate: async () => config }),
    },
    SapCredentials: {
      find: () => ({ lean: async () => credentials }),
    },
  };
}

describe('SapSyncDataAdapter flavor routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes SERVICE_LAYER to the B1 service, untouched', async () => {
    mockServiceLayerExecute.mockResolvedValue([{ CardCode: 'C1' }]);

    const adapter = new SapSyncDataAdapter();
    const result = await adapter.fetchData({
      clientConfigId: 'config-1',
      tenantContext: { tenantModels: buildTenantModels('SERVICE_LAYER') },
      fetchOptions: { mappings: [{ sourceField: 'CardCode' }] },
    });

    expect(mockServiceLayerExecute).toHaveBeenCalledTimes(1);
    expect(mockS4Execute).not.toHaveBeenCalled();
    expect(result).toEqual([{ CardCode: 'C1' }]);
  });

  it('routes S4_ODATA to the S/4 service', async () => {
    mockS4Execute.mockResolvedValue([{ BusinessPartner: '10000' }]);

    const adapter = new SapSyncDataAdapter();
    const result = await adapter.fetchData({
      clientConfigId: 'config-1',
      tenantContext: { tenantModels: buildTenantModels('S4_ODATA') },
      fetchOptions: { mappings: [{ sourceField: 'BusinessPartner' }] },
    });

    expect(mockS4Execute).toHaveBeenCalledTimes(1);
    expect(mockServiceLayerExecute).not.toHaveBeenCalled();
    expect(result).toEqual([{ BusinessPartner: '10000' }]);
  });

  it('merges SapCredentials with the ClientConfig for S/4', async () => {
    mockS4Execute.mockResolvedValue([]);

    const credentials = [{
      serviceLayerBaseUrl: 'https://s4.example.com:44300',
      serviceLayerUsername: 'user',
      serviceLayerPassword: 'pass',
    }];

    const adapter = new SapSyncDataAdapter();
    await adapter.fetchData({
      clientConfigId: 'config-1',
      tenantContext: { tenantModels: buildTenantModels('S4_ODATA', credentials) },
      fetchOptions: { mappings: [{ sourceField: 'BusinessPartner' }] },
    });

    const [mergedConfig, mappings] = mockS4Execute.mock.calls[0];
    expect(mergedConfig).toEqual(expect.objectContaining({
      serviceLayerBaseUrl: 'https://s4.example.com:44300',
      serviceLayerUsername: 'user',
      serviceLayerPath: '/Whatever',
    }));
    expect(mappings).toEqual([{ sourceField: 'BusinessPartner' }]);
  });

  it('fails clearly when an S/4 tenant has no credentials', async () => {
    const adapter = new SapSyncDataAdapter();

    await expect(adapter.fetchData({
      clientConfigId: 'config-1',
      tenantContext: { tenantModels: buildTenantModels('S4_ODATA', []) },
      fetchOptions: {},
    })).rejects.toThrow('SAP credentials not found for S4_ODATA mode');
  });

  it('still returns null for unknown integration modes', async () => {
    const adapter = new SapSyncDataAdapter();
    const result = await adapter.fetchData({
      clientConfigId: 'config-1',
      tenantContext: { tenantModels: buildTenantModels('SOMETHING_ELSE') },
      fetchOptions: {},
    });

    expect(result).toBeNull();
  });
});
