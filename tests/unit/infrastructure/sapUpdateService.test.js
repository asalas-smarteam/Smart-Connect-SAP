import { jest } from '@jest/globals';

const mockQuery = jest.fn();
const mockUpdateBusinessPartner = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/database/externalDb.js', () => ({
  getConnection: jest.fn(() => ({ query: mockQuery })),
}));

jest.unstable_mockModule('../../../src/infrastructure/sap/sap-business-partner.adapter.js', () => ({
  default: {
    updateBusinessPartner: mockUpdateBusinessPartner,
  },
}));

const { sapUpdateService } = await import('../../../src/infrastructure/sap/sapUpdateService.js');

describe('sapUpdateService.updateBusinessPartnerInSapFromHubspot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates SAP SQL fields using reverse FieldMapping from existing HubSpot properties', async () => {
    const mappings = [
      { sourceField: 'CardCode', targetField: 'idsap', isActive: true },
      { sourceField: 'CardName', targetField: 'name', isActive: true },
      { sourceField: 'Phone1', targetField: 'phone', isActive: true },
      { sourceField: 'FederalTaxID', targetField: 'ruc', isActive: true },
    ];
    const tenantModels = {
      FieldMapping: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mappings),
        }),
      },
    };
    const clientConfig = {
      id: 'cfg-1',
      hubspotCredentialId: 'cred-1',
      updateMethod: 'script',
      updateTableName: 'OCRD',
    };

    const result = await sapUpdateService.updateBusinessPartnerInSapFromHubspot(
      clientConfig,
      'company',
      {
        properties: { idsap: 'C001' },
        rawSapData: { CardCode: 'C001' },
      },
      {
        properties: {
          idsap: 'C001',
          name: 'ACME HubSpot',
          phone: '2222',
          ruc: '3101000000',
        },
      },
      tenantModels
    );

    expect(tenantModels.FieldMapping.find).toHaveBeenCalledWith({
      objectType: 'company',
      hubspotCredentialId: 'cred-1',
      isActive: true,
    });
    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE OCRD SET CardName = :field0, Phone1 = :field1, FederalTaxID = :field2 WHERE CardCode = :idSap',
      {
        replacements: {
          idSap: 'C001',
          field0: 'ACME HubSpot',
          field1: '2222',
          field2: '3101000000',
        },
      }
    );
    expect(result).toEqual({ updated: true, method: 'script' });
    expect(mockUpdateBusinessPartner).not.toHaveBeenCalled();
  });

  it('falls back to Service Layer BusinessPartners patch when SQL script config is not available', async () => {
    const mappings = [
      { sourceField: 'CardCode', targetField: 'idsap', isActive: true },
      { sourceField: 'CardName', targetField: 'firstname', isActive: true },
    ];
    const tenantModels = {
      FieldMapping: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mappings),
        }),
      },
      SapCredentials: {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([{ serviceLayerBaseUrl: 'https://sap.example.com' }]),
        }),
      },
    };
    const clientConfig = {
      id: 'cfg-1',
      hubspotCredentialId: 'cred-1',
    };

    const result = await sapUpdateService.updateBusinessPartnerInSapFromHubspot(
      clientConfig,
      'contact',
      { properties: { idsap: 'C002' } },
      { properties: { firstname: 'Ana HubSpot' } },
      tenantModels
    );

    expect(mockUpdateBusinessPartner).toHaveBeenCalledWith({
      sapConfig: expect.objectContaining({
        serviceLayerBaseUrl: 'https://sap.example.com',
        hubspotCredentialId: 'cred-1',
      }),
      cardCode: 'C002',
      payload: {
        CardName: 'Ana HubSpot',
      },
    });
    expect(result).toEqual({ updated: true, method: 'serviceLayer' });
  });
});
