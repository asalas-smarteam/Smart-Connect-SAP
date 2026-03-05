import { jest } from '@jest/globals';

const mockBuildTenantDatabaseName = jest.fn();
const mockGetTenantConnection = jest.fn();
const mockRegisterTenantModels = jest.fn();
const mockSanitizeMongoCollectionName = jest.fn();
const mockReplicateDefaultSapFilters = jest.fn();

const mockMasterConnection = { id: 'master-connection' };

const mockFeatureFlags = {
  updateOne: jest.fn(),
  db: mockMasterConnection,
};
const mockGlobalAuditLog = {
  create: jest.fn(),
};
const mockPaymentStatus = {
  updateOne: jest.fn(),
};
const mockSaaSClient = {
  create: jest.fn(),
};
const mockSubscription = {
  create: jest.fn(),
};

jest.unstable_mockModule('../../src/config/tenantDatabase.js', () => ({
  buildTenantDatabaseName: mockBuildTenantDatabaseName,
  getTenantConnection: mockGetTenantConnection,
}));

jest.unstable_mockModule('../../src/db/models/tenant/index.js', () => ({
  registerTenantModels: mockRegisterTenantModels,
}));

jest.unstable_mockModule('../../src/utils/provisioningValidation.js', () => ({
  sanitizeMongoCollectionName: mockSanitizeMongoCollectionName,
}));

jest.unstable_mockModule('../../src/services/tenant/replicateDefaultSapFilters.js', () => ({
  replicateDefaultSapFilters: mockReplicateDefaultSapFilters,
}));

jest.unstable_mockModule('../../src/config/database.js', () => ({
  FeatureFlags: mockFeatureFlags,
  GlobalAuditLog: mockGlobalAuditLog,
  PaymentStatus: mockPaymentStatus,
  SaaSClient: mockSaaSClient,
  Subscription: mockSubscription,
}));

const { provisionTenant } = await import('../../src/services/tenantProvisioning.js');

describe('provisionTenant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReplicateDefaultSapFilters.mockResolvedValue();
  });

  it('creates tenant, subscription, and collections with generated tenantKey', async () => {
    mockSanitizeMongoCollectionName.mockReturnValue('acme_inc');
    mockBuildTenantDatabaseName.mockReturnValue('tenant_acme_inc');

    const client = { _id: 'client-id', companyName: 'Acme Inc' };
    const subscription = { _id: 'subscription-id' };

    mockSaaSClient.create.mockResolvedValue(client);
    mockSubscription.create.mockResolvedValue(subscription);

    const existingCollections = [{ name: 'orders' }];
    const listCollections = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(existingCollections),
    });
    const createCollection = jest.fn().mockResolvedValue();

    const tenantConnection = {
      db: { listCollections },
      createCollection,
    };

    mockGetTenantConnection.mockResolvedValue(tenantConnection);

    mockRegisterTenantModels.mockReturnValue({
      Orders: { collection: { name: 'orders' } },
      Products: { collection: { name: 'products' } },
      IntegrationMode: {
        collection: { name: 'integrationmodes' },
        updateOne: jest.fn().mockResolvedValue(),
      },
    });

    mockPaymentStatus.updateOne.mockResolvedValue();
    mockFeatureFlags.updateOne.mockResolvedValue();
    mockGlobalAuditLog.create.mockResolvedValue();

    const result = await provisionTenant({
      companyName: 'Acme Inc',
      planId: 'plan-1',
      billingEmail: 'billing@acme.test',
      hubspot: { portalId: 123 },
    });

    expect(mockSanitizeMongoCollectionName).toHaveBeenCalledWith('Acme Inc');
    expect(mockBuildTenantDatabaseName).toHaveBeenCalledWith('acme_inc');
    expect(mockSaaSClient.create).toHaveBeenCalledWith({
      companyName: 'Acme Inc',
      tenantKey: 'tenant_acme_inc',
      status: 'active',
      billingEmail: 'billing@acme.test',
      hubspot: { portalId: 123 },
    });
    expect(mockSubscription.create).toHaveBeenCalledWith({
      clientId: 'client-id',
      planId: 'plan-1',
      status: 'active',
      paymentStatus: 'paid',
    });
    expect(mockReplicateDefaultSapFilters).toHaveBeenCalledWith({
      masterConnection: mockMasterConnection,
      tenantConnection,
    });
    expect(createCollection).toHaveBeenCalledTimes(2);
    expect(createCollection).toHaveBeenCalledWith('products');
    expect(createCollection).toHaveBeenCalledWith('integrationmodes');
    expect(mockGlobalAuditLog.create).toHaveBeenCalledWith({
      action: 'tenant.provisioned',
      tenantKey: 'tenant_acme_inc',
      resourceType: 'SaaSClient',
      resourceId: 'client-id',
      payload: {
        companyName: 'Acme Inc',
        planId: 'plan-1',
        billingEmail: 'billing@acme.test',
        hubspot: { portalId: 123 },
        subscriptionId: 'subscription-id',
      },
    });
    expect(result).toEqual({
      client,
      subscription,
      tenantKey: 'tenant_acme_inc',
    });
  });

  it('logs provisioning failure when collection creation fails', async () => {
    mockSanitizeMongoCollectionName.mockReturnValue('broken');
    mockBuildTenantDatabaseName.mockReturnValue('tenant_broken');

    const client = { _id: 'client-id', companyName: 'Broken Inc' };
    const subscription = { _id: 'subscription-id' };

    mockSaaSClient.create.mockResolvedValue(client);
    mockSubscription.create.mockResolvedValue(subscription);

    const listCollections = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
    });
    const createCollection = jest.fn().mockRejectedValue(new Error('collection failed'));

    const tenantConnection = {
      db: { listCollections },
      createCollection,
    };

    mockGetTenantConnection.mockResolvedValue(tenantConnection);

    mockRegisterTenantModels.mockReturnValue({
      Orders: { collection: { name: 'orders' } },
      IntegrationMode: {
        collection: { name: 'integrationmodes' },
        updateOne: jest.fn().mockResolvedValue(),
      },
    });

    mockPaymentStatus.updateOne.mockResolvedValue();
    mockFeatureFlags.updateOne.mockResolvedValue();
    mockGlobalAuditLog.create.mockResolvedValue();

    await expect(
      provisionTenant({
        companyName: 'Broken Inc',
        planId: 'plan-9',
      })
    ).rejects.toThrow('collection failed');

    expect(mockGlobalAuditLog.create).toHaveBeenCalledWith({
      action: 'tenant.provisioning_failed',
      tenantKey: 'tenant_broken',
      payload: {
        companyName: 'Broken Inc',
        planId: 'plan-9',
        billingEmail: null,
        hubspot: null,
        error: {
          message: 'collection failed',
          stack: expect.any(String),
        },
      },
    });
  });

  it('creates HubSpot credentials when tenant payload contains access token', async () => {
    mockSanitizeMongoCollectionName.mockReturnValue('seeded');
    mockBuildTenantDatabaseName.mockReturnValue('tenant_seeded');

    const client = { _id: 'client-id', companyName: 'Seeded Inc' };
    const subscription = { _id: 'subscription-id' };
    const hubspotCredential = { _id: 'credential-id', accessToken: 'token-123' };
    const mockCreateHubspotCredentials = jest.fn().mockResolvedValue(hubspotCredential);

    mockSaaSClient.create.mockResolvedValue(client);
    mockSubscription.create.mockResolvedValue(subscription);

    const tenantConnection = {
      db: {
        listCollections: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      },
      createCollection: jest.fn().mockResolvedValue(),
    };

    mockGetTenantConnection.mockResolvedValue(tenantConnection);

    mockRegisterTenantModels.mockReturnValue({
      Orders: { collection: { name: 'orders' } },
      IntegrationMode: {
        collection: { name: 'integrationmodes' },
        updateOne: jest.fn().mockResolvedValue(),
      },
      HubspotCredentials: {
        create: mockCreateHubspotCredentials,
      },
    });

    mockFeatureFlags.updateOne.mockResolvedValue();
    mockGlobalAuditLog.create.mockResolvedValue();

    await provisionTenant({
      companyName: 'Seeded Inc',
      planId: 'plan-2',
      hubspot: {
        portalId: '1001',
        accessToken: 'token-123',
      },
    });

    expect(mockCreateHubspotCredentials).toHaveBeenCalledWith({
      portalId: '1001',
      accessToken: 'token-123',
      refreshToken: null,
      expiresAt: null,
      scope: null,
    });
  });
});
