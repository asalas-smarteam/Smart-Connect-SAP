import { jest } from '@jest/globals';

const mockSpExecute = jest.fn();
const mockScriptExecute = jest.fn();
const mockApiExecute = jest.fn();
const mockGetMappingsByObjectType = jest.fn();
const mockServiceLayerExecute = jest.fn();

jest.unstable_mockModule('../../src/integrations/sap/modes/spMode.js', () => ({
  default: { execute: mockSpExecute },
}));

jest.unstable_mockModule('../../src/integrations/sap/modes/scriptMode.js', () => ({
  default: { execute: mockScriptExecute },
}));

jest.unstable_mockModule('../../src/integrations/sap/modes/apiMode.js', () => ({
  default: { execute: mockApiExecute },
}));

jest.unstable_mockModule('../../src/services/mapping.service.js', () => ({
  default: { getMappingsByObjectType: mockGetMappingsByObjectType },
}));

jest.unstable_mockModule('../../src/services/serviceLayer.service.js', () => ({
  default: { execute: mockServiceLayerExecute },
}));

const sapService = (await import('../../src/integrations/sap/sapService.js')).default;

describe('sapService.fetchData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retrieves service-layer mappings by hubspotCredentialId and objectType', async () => {
    const config = {
      integrationModeId: { name: 'SERVICE_LAYER' },
      hubspotCredentialId: 'cred-1',
      objectType: 'company',
      toObject() {
        return {
          integrationModeId: { name: 'SERVICE_LAYER' },
          hubspotCredentialId: 'cred-1',
          objectType: 'company',
        };
      },
    };

    const tenantModels = {
      ClientConfig: {
        findById: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(config),
        }),
      },
      SapCredentials: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([{ serviceLayerBaseUrl: 'https://sap.example.com' }]),
        }),
      },
    };

    mockGetMappingsByObjectType.mockResolvedValue([{ sourceField: 'CardName', targetField: 'name' }]);
    mockServiceLayerExecute.mockResolvedValue([{ CardName: 'Acme' }]);

    const result = await sapService.fetchData('client-config-1', tenantModels);

    expect(mockGetMappingsByObjectType).toHaveBeenCalledWith(
      'cred-1',
      'company',
      'businessPartner',
      tenantModels
    );
    expect(mockServiceLayerExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceLayerBaseUrl: 'https://sap.example.com',
        hubspotCredentialId: 'cred-1',
        objectType: 'company',
      }),
      [{ sourceField: 'CardName', targetField: 'name' }],
      {}
    );
    expect(result).toEqual([{ CardName: 'Acme' }]);
  });
});
