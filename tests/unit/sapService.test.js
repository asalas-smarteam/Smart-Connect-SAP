import { jest } from '@jest/globals';

const mockSpExecute = jest.fn();
const mockScriptExecute = jest.fn();
const mockApiExecute = jest.fn();
const mockServiceLayerExecute = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/sap/modes/spMode.js', () => ({
  default: { execute: mockSpExecute },
}));

jest.unstable_mockModule('../../src/infrastructure/sap/modes/scriptMode.js', () => ({
  default: { execute: mockScriptExecute },
}));

jest.unstable_mockModule('../../src/infrastructure/sap/modes/apiMode.js', () => ({
  default: { execute: mockApiExecute },
}));

jest.unstable_mockModule('../../src/infrastructure/sap/serviceLayer.service.js', () => ({
  default: { execute: mockServiceLayerExecute },
}));

const sapService = (await import('../../src/infrastructure/sap/sapService.js')).default;

describe('sapService.fetchData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes service-layer mappings from fetch options to SAP transport', async () => {
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

    mockServiceLayerExecute.mockResolvedValue([{ CardName: 'Acme' }]);
    const mappings = [{ sourceField: 'CardName', targetField: 'name' }];

    const result = await sapService.fetchData('client-config-1', tenantModels, { mappings });
    expect(mockServiceLayerExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceLayerBaseUrl: 'https://sap.example.com',
        hubspotCredentialId: 'cred-1',
        objectType: 'company',
      }),
      mappings,
      { mappings }
    );
    expect(result).toEqual([{ CardName: 'Acme' }]);
  });
});
