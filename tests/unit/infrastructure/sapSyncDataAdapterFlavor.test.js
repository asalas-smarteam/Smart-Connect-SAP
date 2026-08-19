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

  // Antes devolvía null, y ese null llegaba al sync como "SAP no tenía datos".
  // Ver el bloque de abajo: ahora falla nombrando el modo.
  it('fails instead of returning null for unknown integration modes', async () => {
    const adapter = new SapSyncDataAdapter();

    await expect(adapter.fetchData({
      clientConfigId: 'config-1',
      tenantContext: { tenantModels: buildTenantModels('SOMETHING_ELSE') },
      fetchOptions: {},
    })).rejects.toThrow(/SOMETHING_ELSE/);
  });
});

// Una config cuyo modo no resuelve devolvía null en silencio: el sync la leía
// como "SAP no tenía datos" y cerraba el SyncLog en verde con 0 registros y sin
// error. Así estuvo una semana la tarea de facturas de Distelsa, apuntando a un
// integrationModeId que no existía en ninguna base.
describe('SapSyncDataAdapter unusable configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildModels(config) {
    return {
      ClientConfig: { findById: () => ({ populate: async () => config }) },
      SapCredentials: { find: () => ({ lean: async () => [] }) },
    };
  }

  it('fails naming the config when the integration mode does not resolve', async () => {
    const adapter = new SapSyncDataAdapter();

    await expect(adapter.fetchData({
      clientConfigId: 'cfg-1',
      tenantContext: {
        tenantModels: buildModels({
          _id: 'cfg-1',
          clientName: 'Obtener Facturas',
          integrationModeId: null,
        }),
      },
    })).rejects.toThrow(/Obtener Facturas.*cfg-1/s);
  });

  it('fails when the mode resolves to a name this adapter cannot route', async () => {
    const adapter = new SapSyncDataAdapter();

    await expect(adapter.fetchData({
      clientConfigId: 'cfg-1',
      tenantContext: {
        tenantModels: buildModels({
          _id: 'cfg-1',
          clientName: 'Obtener Facturas',
          integrationModeId: { name: 'FTP_DROP' },
        }),
      },
    })).rejects.toThrow(/FTP_DROP/);
  });

  it('fails when the client config id does not exist at all', async () => {
    const adapter = new SapSyncDataAdapter();

    await expect(adapter.fetchData({
      clientConfigId: 'cfg-fantasma',
      tenantContext: { tenantModels: buildModels(null) },
    })).rejects.toThrow(/cfg-fantasma/);
  });

  it('never resolves to null, so an empty read can only mean SAP returned nothing', async () => {
    mockServiceLayerExecute.mockResolvedValue([]);

    const adapter = new SapSyncDataAdapter();
    const result = await adapter.fetchData({
      clientConfigId: 'config-1',
      tenantContext: { tenantModels: buildTenantModels('SERVICE_LAYER') },
    });

    expect(result).toEqual([]);
  });
});
