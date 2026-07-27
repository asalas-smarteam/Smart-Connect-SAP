import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/infrastructure/sap/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: jest.fn(),
    resolveTenantKey: jest.fn(),
    invalidateSession: jest.fn(),
  },
  isSessionInvalidError: () => false,
}));

jest.unstable_mockModule('axios', () => ({
  default: jest.fn(),
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { B1CustomerAdapter } = await import(
  '../../../src/infrastructure/sap/customers/B1CustomerAdapter.js'
);
const { S4CustomerAdapter } = await import(
  '../../../src/infrastructure/sap/customers/S4CustomerAdapter.js'
);
const { createSapCustomerAdapter } = await import(
  '../../../src/infrastructure/sap/customers/sapCustomerAdapterFactory.js'
);

function buildFakeTransport() {
  return {
    request: jest.fn(),
    fetchAll: jest.fn(),
  };
}

describe('B1CustomerAdapter', () => {
  it('fetches /BusinessPartners and maps records to domain customers', async () => {
    const transport = buildFakeTransport();
    transport.fetchAll.mockResolvedValue([
      { CardCode: 'C1', CardName: 'Acme', CardType: 'C', CompanyPrivate: 'C' },
    ]);

    const adapter = new B1CustomerAdapter({ transport });
    const customers = await adapter.fetchCustomers({
      query: { $select: 'CardCode,CardName' },
    });

    expect(transport.fetchAll).toHaveBeenCalledWith({
      path: '/BusinessPartners',
      query: { $select: 'CardCode,CardName' },
      headers: undefined,
    });
    expect(customers).toHaveLength(1);
    expect(customers[0]).toEqual(
      expect.objectContaining({ idSap: 'C1', name: 'Acme', isCustomer: true })
    );
  });

  it('fetches a single partner by CardCode and returns null on 404', async () => {
    const transport = buildFakeTransport();
    transport.request.mockResolvedValueOnce({ CardCode: 'C1', CardName: 'Acme' });

    const adapter = new B1CustomerAdapter({ transport });
    const found = await adapter.fetchCustomerById('C1');

    expect(transport.request).toHaveBeenCalledWith({
      method: 'get',
      path: "/BusinessPartners('C1')",
    });
    expect(found.idSap).toBe('C1');

    const notFound = new Error('not found');
    notFound.response = { status: 404 };
    transport.request.mockRejectedValueOnce(notFound);

    await expect(adapter.fetchCustomerById('C404')).resolves.toBeNull();
    await expect(adapter.fetchCustomerById('   ')).resolves.toBeNull();
  });
});

describe('S4CustomerAdapter', () => {
  it('applies the contact expand by default and maps records', async () => {
    const transport = buildFakeTransport();
    transport.fetchAll.mockResolvedValue([
      {
        BusinessPartner: '10000',
        Customer: '10000',
        BusinessPartnerCategory: '2',
        OrganizationBPName1: 'Acme SRL',
      },
    ]);

    const adapter = new S4CustomerAdapter({ transport });
    const customers = await adapter.fetchCustomers();

    expect(transport.fetchAll).toHaveBeenCalledWith({
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: {
        $expand: 'to_BusinessPartnerAddress/to_EmailAddress,to_BusinessPartnerAddress/to_PhoneNumber,to_Customer',
      },
      headers: undefined,
    });
    expect(customers[0]).toEqual(
      expect.objectContaining({ idSap: '10000', name: 'Acme SRL', isCustomer: true })
    );
  });

  it('lets callers override the default expand', async () => {
    const transport = buildFakeTransport();
    transport.fetchAll.mockResolvedValue([]);

    const adapter = new S4CustomerAdapter({ transport });
    await adapter.fetchCustomers({
      query: { $expand: 'to_Customer', $top: 10 },
    });

    expect(transport.fetchAll).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { $expand: 'to_Customer', $top: 10 },
      })
    );
  });

  it('fetches a single partner by BusinessPartner id', async () => {
    const transport = buildFakeTransport();
    transport.request.mockResolvedValue({
      BusinessPartner: '10000',
      BusinessPartnerCategory: '1',
      BusinessPartnerFullName: 'Oficina Local',
    });

    const adapter = new S4CustomerAdapter({ transport });
    const customer = await adapter.fetchCustomerById('10000');

    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/API_BUSINESS_PARTNER/A_BusinessPartner('10000')" })
    );
    expect(customer.idSap).toBe('10000');
  });
});

describe('createSapCustomerAdapter', () => {
  const transport = buildFakeTransport();

  it('resolves S4 to the S4 adapter and B1/default to the B1 adapter', () => {
    expect(createSapCustomerAdapter({ sapFlavor: 'S4', transport })).toBeInstanceOf(S4CustomerAdapter);
    expect(createSapCustomerAdapter({ sapFlavor: 'B1', transport })).toBeInstanceOf(B1CustomerAdapter);
    expect(createSapCustomerAdapter({ transport })).toBeInstanceOf(B1CustomerAdapter);
    expect(createSapCustomerAdapter({ sapFlavor: 'HANA', transport })).toBeInstanceOf(B1CustomerAdapter);
  });

  it('builds a flavor-matching transport when none is injected', () => {
    const adapter = createSapCustomerAdapter({
      sapFlavor: 'S4',
      config: {
        serviceLayerBaseUrl: 'https://s4.example.com:44300',
        serviceLayerUsername: 'user',
        serviceLayerPassword: 'pass',
      },
    });

    expect(adapter).toBeInstanceOf(S4CustomerAdapter);
    expect(adapter.transport).toBeDefined();
  });
});
