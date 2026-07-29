import { jest } from '@jest/globals';

const mockResolveSapFlavor = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/config/SapFlavorConfigRepository.js', () => ({
  resolveSapFlavor: mockResolveSapFlavor,
  SapFlavorConfigRepository: class {},
  default: class {},
}));

jest.unstable_mockModule('../../../src/infrastructure/sap/transport/sapTransportFactory.js', () => ({
  createSapTransport: jest.fn(() => ({ fetchAll: jest.fn() })),
}));

const { S4ContactEnrichmentAdapter, S4_CONTACTS_KEY } = await import(
  '../../../src/infrastructure/sap/customers/S4ContactEnrichmentAdapter.js'
);

function buildTenantModels(credentials = [{ serviceLayerBaseUrl: 'https://s4' }]) {
  return {
    SapCredentials: { find: () => ({ lean: async () => credentials }) },
  };
}

function buildRecords(companyIds) {
  return companyIds.map((id) => ({
    properties: { idsap: id },
    rawSapData: { BusinessPartner: id },
  }));
}

const silentLogger = { warn: jest.fn(), error: jest.fn() };

describe('S4ContactEnrichmentAdapter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is a no-op for non-company syncs', async () => {
    const adapter = new S4ContactEnrichmentAdapter({ logger: silentLogger });
    const records = buildRecords(['100051']);

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: buildTenantModels() });

    expect(records[0].rawSapData[S4_CONTACTS_KEY]).toBeUndefined();
    expect(mockResolveSapFlavor).not.toHaveBeenCalled();
  });

  it('is a no-op for non-S/4 tenants (B1 untouched)', async () => {
    mockResolveSapFlavor.mockResolvedValue('B1');
    const resolverFactory = jest.fn();
    const adapter = new S4ContactEnrichmentAdapter({ resolverFactory, logger: silentLogger });
    const records = buildRecords(['100051']);

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels: buildTenantModels() });

    expect(records[0].rawSapData[S4_CONTACTS_KEY]).toBeUndefined();
    expect(resolverFactory).not.toHaveBeenCalled();
  });

  it('attaches resolved contact persons per company for S/4', async () => {
    mockResolveSapFlavor.mockResolvedValue('S4');

    const persons51 = [{ BusinessPartner: '100000', FirstName: 'Oscar' }];
    const resolver = {
      resolveContactsByCompany: jest.fn(async () => new Map([['100051', persons51]])),
    };
    const resolverFactory = jest.fn(() => resolver);

    const adapter = new S4ContactEnrichmentAdapter({ resolverFactory, logger: silentLogger });
    const records = buildRecords(['100051', '100052']);

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels: buildTenantModels() });

    // Resolver built from the tenant credentials and asked for both companies.
    expect(resolverFactory).toHaveBeenCalledWith(expect.objectContaining({ serviceLayerBaseUrl: 'https://s4' }));
    expect(resolver.resolveContactsByCompany).toHaveBeenCalledWith(['100051', '100052']);

    // Company with contacts gets them; company without gets an empty array.
    expect(records[0].rawSapData[S4_CONTACTS_KEY]).toEqual(persons51);
    expect(records[1].rawSapData[S4_CONTACTS_KEY]).toEqual([]);
  });

  it('skips when the tenant has no SAP credentials', async () => {
    mockResolveSapFlavor.mockResolvedValue('S4');
    const resolverFactory = jest.fn();
    const adapter = new S4ContactEnrichmentAdapter({ resolverFactory, logger: silentLogger });
    const records = buildRecords(['100051']);

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels: buildTenantModels([]) });

    expect(resolverFactory).not.toHaveBeenCalled();
    expect(records[0].rawSapData[S4_CONTACTS_KEY]).toBeUndefined();
  });

  it('swallows resolver errors so the company sync is not aborted', async () => {
    mockResolveSapFlavor.mockResolvedValue('S4');
    const resolver = {
      resolveContactsByCompany: jest.fn(async () => { throw new Error('gateway down'); }),
    };
    const adapter = new S4ContactEnrichmentAdapter({ resolverFactory: () => resolver, logger: silentLogger });
    const records = buildRecords(['100051']);

    await expect(
      adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels: buildTenantModels() })
    ).resolves.toBeUndefined();
    expect(silentLogger.error).toHaveBeenCalled();
  });
});
