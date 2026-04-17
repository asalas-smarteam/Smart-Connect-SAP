import { jest } from '@jest/globals';

const mockGetAccessToken = jest.fn();
const mockRegisterBaseObjectMapping = jest.fn();
const mockHandleAssociations = jest.fn();
const mockUpdateHubspotIdInSap = jest.fn();
const mockBatchCreateProducts = jest.fn();
const mockBatchUpdateProducts = jest.fn();
const mockProductFind = jest.fn();
const mockProductCreate = jest.fn();
const mockProductUpdate = jest.fn();
const mockProductPreprocess = jest.fn();
const mockContactFind = jest.fn();
const mockContactCreate = jest.fn();
const mockContactUpdate = jest.fn();
const mockCompanyFind = jest.fn();
const mockCompanyCreate = jest.fn();
const mockCompanyUpdate = jest.fn();

jest.unstable_mockModule('../../src/services/hubspotAuthService.js', () => ({
  default: {
    getAccessToken: mockGetAccessToken,
  },
}));

jest.unstable_mockModule('../../src/services/hubspotClient.js', () => ({
  batchCreateProducts: mockBatchCreateProducts,
  batchUpdateProducts: mockBatchUpdateProducts,
}));

jest.unstable_mockModule('../../src/services/associationRegistryService.js', () => ({
  default: {
    registerBaseObjectMapping: mockRegisterBaseObjectMapping,
  },
}));

jest.unstable_mockModule('../../src/services/hubspot/associationOrchestrator.js', () => ({
  default: {
    handleAssociations: mockHandleAssociations,
  },
}));

jest.unstable_mockModule('../../src/services/hubspot/sapSyncAdapter.js', () => ({
  default: {
    updateHubspotIdInSap: mockUpdateHubspotIdInSap,
  },
}));

jest.unstable_mockModule('../../src/services/hubspot/handlers/contact.handler.js', () => ({
  default: {
    find: mockContactFind,
    create: mockContactCreate,
    update: mockContactUpdate,
  },
}));

jest.unstable_mockModule('../../src/services/hubspot/handlers/company.handler.js', () => ({
  default: {
    find: mockCompanyFind,
    create: mockCompanyCreate,
    update: mockCompanyUpdate,
  },
}));

jest.unstable_mockModule('../../src/services/hubspot/handlers/deal.handler.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../../src/services/hubspot/handlers/product.handler.js', () => ({
  default: {
    find: mockProductFind,
    create: mockProductCreate,
    update: mockProductUpdate,
    preprocess: mockProductPreprocess,
  },
}));

const { sendToHubSpot } = await import('../../src/services/hubspot/syncOrchestrator.js');

describe('sendToHubSpot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockResolvedValue('hubspot-token');
    mockProductPreprocess.mockImplementation(async ({ item }) => item);
  });

  it('refresh-checks token during product sync and uses HubSpot batch endpoints when configured', async () => {
    const clientConfig = {
      hubspotCredentialId: 'cred-1',
      hubspotBatchSize: 2,
    };

    const credentials = {
      _id: 'cred-1',
      accessToken: 'stale-token',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const items = [
      { properties: { hs_sku: 'SKU-1', name: 'Producto 1' }, rawSapData: { ItemCode: 'SKU-1' } },
      { properties: { hs_sku: 'SKU-2', name: 'Producto 2' }, rawSapData: { ItemCode: 'SKU-2' } },
      { properties: { hs_sku: 'SKU-3', name: 'Producto 3' }, rawSapData: { ItemCode: 'SKU-3' } },
    ];

    mockProductFind
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hs-2' })
      .mockResolvedValueOnce(null);

    mockBatchCreateProducts
      .mockResolvedValueOnce({
        results: [{ id: 'hs-1', properties: { hs_sku: 'SKU-1' } }],
      })
      .mockResolvedValueOnce({
        results: [{ id: 'hs-3', properties: { hs_sku: 'SKU-3' } }],
      });

    mockBatchUpdateProducts.mockResolvedValue({
      results: [{ id: 'hs-2' }],
    });

    const result = await sendToHubSpot(
      items,
      clientConfig,
      'product',
      {},
      credentials
    );

    expect(result).toEqual({ ok: true, sent: 3, failed: 0 });
    expect(mockGetAccessToken).toHaveBeenCalledTimes(6);
    expect(mockBatchCreateProducts).toHaveBeenNthCalledWith(1, 'hubspot-token', {
      inputs: [items[0]],
    });
    expect(mockBatchUpdateProducts).toHaveBeenCalledWith('hubspot-token', {
      inputs: [
        {
          id: 'hs-2',
          properties: items[1].properties,
        },
      ],
    });
    expect(mockBatchCreateProducts).toHaveBeenNthCalledWith(2, 'hubspot-token', {
      inputs: [items[2]],
    });
    expect(mockUpdateHubspotIdInSap).toHaveBeenCalledTimes(2);
    expect(mockRegisterBaseObjectMapping).toHaveBeenNthCalledWith(
      1,
      'cred-1',
      'product',
      'SKU-1',
      'hs-1',
      {},
    );
    expect(mockRegisterBaseObjectMapping).toHaveBeenNthCalledWith(
      2,
      'cred-1',
      'product',
      'SKU-3',
      'hs-3',
      {},
    );
    expect(mockProductCreate).not.toHaveBeenCalled();
    expect(mockProductUpdate).not.toHaveBeenCalled();
    expect(mockHandleAssociations).not.toHaveBeenCalled();
  });

  it('passes existing HubSpot record into contact updates', async () => {
    const clientConfig = {
      hubspotCredentialId: 'cred-1',
    };

    const credentials = {
      _id: 'cred-1',
      accessToken: 'stale-token',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const item = {
      properties: {
        email: 'contact@example.com',
        firstname: 'Contact Name',
        idsap: 'BP-01',
      },
    };

    const existing = {
      id: 'hs-contact-1',
      properties: {
        firstname: 'Old Contact',
        idsap: 'BP-00',
      },
    };

    mockContactFind.mockResolvedValue(existing);
    mockContactUpdate.mockResolvedValue(existing);

    const result = await sendToHubSpot(
      [item],
      clientConfig,
      'contact',
      {},
      credentials
    );

    expect(result).toEqual({ ok: true, sent: 1, failed: 0 });
    expect(mockContactUpdate).toHaveBeenCalledWith({
      token: 'hubspot-token',
      id: 'hs-contact-1',
      existing,
      item,
      clientConfig,
      tenantModels: {},
    });
    expect(mockHandleAssociations).toHaveBeenCalledWith({
      objectType: 'contact',
      token: 'hubspot-token',
      item,
      clientConfig,
      tenantModels: {},
      hubspotId: 'hs-contact-1',
    });
    expect(mockContactCreate).not.toHaveBeenCalled();
  });
});
