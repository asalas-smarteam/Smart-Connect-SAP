import { jest } from '@jest/globals';

const mockSaaSClientFindOne = jest.fn();
const mockSubscriptionFindOne = jest.fn();
const mockGetTenantConnection = jest.fn();
const mockGetTenantModels = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/database/master/database.js', () => ({
  SaaSClient: { findOne: mockSaaSClientFindOne },
  Subscription: { findOne: mockSubscriptionFindOne },
}));

jest.unstable_mockModule('../../../src/infrastructure/database/tenant/tenantDatabase.js', () => ({
  getTenantConnection: mockGetTenantConnection,
  getTenantModels: mockGetTenantModels,
}));

const { tenantResolver, adminTenantResolver } = await import(
  '../../../src/interfaces/http/middlewares/tenantResolver.js'
);

const ACTIVE_CLIENT = { _id: 'tenant-1', tenantKey: 'printer', status: 'active' };

function buildReply() {
  return {
    code: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

function activeSubscription() {
  mockSubscriptionFindOne.mockReturnValue({
    sort: jest.fn().mockResolvedValue({ status: 'active', paymentStatus: 'paid' }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTenantConnection.mockResolvedValue({});
  mockGetTenantModels.mockResolvedValue({ models: true });
  activeSubscription();
});

describe('adminTenantResolver', () => {
  it('resolves the tenant from the x-tenant-id header', async () => {
    mockSaaSClientFindOne.mockResolvedValue(ACTIVE_CLIENT);
    const req = { headers: { 'x-tenant-id': 'tenant-1' }, query: {}, body: {} };
    const reply = buildReply();

    await adminTenantResolver(req, reply);

    expect(mockSaaSClientFindOne).toHaveBeenCalledWith({ _id: 'tenant-1' });
    expect(reply.code).not.toHaveBeenCalled();
    expect(req.tenantKey).toBe('printer');
    expect(req.tenantModels).toEqual({ models: true });
  });

  it.each([
    ['a tenantId query param', { headers: {}, query: { tenantId: 'tenant-1' }, body: {} }],
    ['a tenantId in the body', { headers: {}, query: {}, body: { tenantId: 'tenant-1' } }],
    ['a portalId query param', { headers: {}, query: { portalId: '50082681' }, body: {} }],
    ['a portalId array body', { headers: {}, query: {}, body: [{ portalId: 50082681 }] }],
    ['a bearer token', { headers: { authorization: 'Bearer anything' }, query: {}, body: {} }],
  ])('rejects %s without looking up any tenant', async (_label, req) => {
    const reply = buildReply();

    await adminTenantResolver(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'x-tenant-id header is required' });
    expect(mockSaaSClientFindOne).not.toHaveBeenCalled();
    expect(req.tenantModels).toBeUndefined();
  });

  it('answers 403 for an unknown tenant', async () => {
    mockSaaSClientFindOne.mockResolvedValue(null);
    const reply = buildReply();

    await adminTenantResolver({ headers: { 'x-tenant-id': 'missing' }, query: {}, body: {} }, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
  });
});

describe('tenantResolver', () => {
  it('keeps resolving HubSpot workflow webhooks by x-tenant-id', async () => {
    mockSaaSClientFindOne.mockResolvedValue(ACTIVE_CLIENT);
    const req = {
      headers: { 'x-tenant-id': 'tenant-1' },
      query: {},
      body: { portalId: '50082681', deal: {} },
    };
    const reply = buildReply();

    await tenantResolver(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(req.tenantKey).toBe('printer');
  });

  it('keeps resolving HubSpot subscription webhooks by the portalId of the array body', async () => {
    mockSaaSClientFindOne.mockResolvedValue(ACTIVE_CLIENT);
    const req = { headers: {}, query: {}, body: [{ portalId: 50082681 }] };
    const reply = buildReply();

    await tenantResolver(req, reply);

    expect(mockSaaSClientFindOne).toHaveBeenCalledWith({ 'hubspot.portalId': '50082681' });
    expect(req.tenantKey).toBe('printer');
  });

  it('answers 403 instead of crashing when an object body carries no tenant', async () => {
    const req = { headers: {}, query: {}, body: { portalId: '50082681', deal: {} } };
    const reply = buildReply();

    await tenantResolver(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(mockSaaSClientFindOne).not.toHaveBeenCalled();
  });

  it('answers 403 instead of crashing when there is no body at all', async () => {
    const reply = buildReply();

    await tenantResolver({ headers: {}, query: {} }, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
  });
});
