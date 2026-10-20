import { jest } from '@jest/globals';
import MongoosePanelUserRepository from '../../../src/infrastructure/database/repositories/MongoosePanelUserRepository.js';
import SaaSClientTenantDirectory from '../../../src/infrastructure/database/repositories/SaaSClientTenantDirectory.js';
import { PanelEmailTakenError } from '../../../src/domain/panel/errors.js';

const USER_ID = '6710a1b2c3d4e5f601234567';

function leanQuery(result) {
  const query = {
    sort: jest.fn(() => query),
    skip: jest.fn(() => query),
    limit: jest.fn(() => query),
    select: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(result),
  };
  return query;
}

function userDocument(overrides = {}) {
  return {
    _id: { toString: () => USER_ID },
    email: 'ana@acme.test',
    name: 'Ana',
    accountType: 'cliente',
    tenantKey: 'sap_integration_acme',
    role: 'admin',
    passwordHash: 'scrypt$hash',
    mustChangePassword: true,
    active: true,
    tokenVersion: 2,
    lastLoginAt: null,
    createdBy: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    __v: 0,
    ...overrides,
  };
}

describe('MongoosePanelUserRepository', () => {
  it('returns plain users with a string id', async () => {
    const model = { findOne: jest.fn(() => leanQuery(userDocument())) };
    const repository = new MongoosePanelUserRepository({ model });

    const user = await repository.findByEmail('ana@acme.test');

    expect(model.findOne).toHaveBeenCalledWith({ email: 'ana@acme.test' });
    expect(user).toEqual(expect.objectContaining({
      id: USER_ID,
      email: 'ana@acme.test',
      tokenVersion: 2,
      mustChangePassword: true,
      active: true,
    }));
    expect(user).not.toHaveProperty('_id');
    expect(user).not.toHaveProperty('__v');
  });

  it('returns null for malformed ids without querying', async () => {
    const model = {
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
    };
    const repository = new MongoosePanelUserRepository({ model });

    await expect(repository.findById('no-es-un-id')).resolves.toBeNull();
    await expect(repository.update('no-es-un-id', { name: 'x' })).resolves.toBeNull();
    await expect(repository.incrementTokenVersion('no-es-un-id')).resolves.toBeNull();
    await repository.touchLastLogin('no-es-un-id', new Date());

    expect(model.findById).not.toHaveBeenCalled();
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('translates a duplicate key error into PanelEmailTakenError', async () => {
    const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const model = { create: jest.fn().mockRejectedValue(duplicate) };
    const repository = new MongoosePanelUserRepository({ model });

    await expect(repository.create({ email: 'ana@acme.test' })).rejects.toBeInstanceOf(PanelEmailTakenError);
  });

  it('rethrows other errors on create', async () => {
    const failure = new Error('connection lost');
    const model = { create: jest.fn().mockRejectedValue(failure) };
    const repository = new MongoosePanelUserRepository({ model });

    await expect(repository.create({ email: 'ana@acme.test' })).rejects.toBe(failure);
  });

  it('increments tokenVersion and applies the extra patch atomically', async () => {
    const model = { findOneAndUpdate: jest.fn(() => leanQuery(userDocument({ tokenVersion: 3 }))) };
    const repository = new MongoosePanelUserRepository({ model });

    const user = await repository.incrementTokenVersion(USER_ID, { mustChangePassword: false });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: USER_ID },
      { $inc: { tokenVersion: 1 }, $set: { mustChangePassword: false } },
      { new: true, runValidators: true }
    );
    expect(user.tokenVersion).toBe(3);
  });

  it('only increments when the expected version still matches (compare-and-set)', async () => {
    const model = { findOneAndUpdate: jest.fn(() => leanQuery(null)) };
    const repository = new MongoosePanelUserRepository({ model });

    const user = await repository.incrementTokenVersion(USER_ID, { passwordHash: 'x' }, { expectedVersion: 2 });

    expect(model.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: USER_ID, tokenVersion: 2 });
    expect(user).toBeNull();
  });

  it('increments tokenVersion without an empty $set', async () => {
    const model = { findOneAndUpdate: jest.fn(() => leanQuery(userDocument())) };
    const repository = new MongoosePanelUserRepository({ model });

    await repository.incrementTokenVersion(USER_ID);

    expect(model.findOneAndUpdate.mock.calls[0][1]).toEqual({ $inc: { tokenVersion: 1 } });
  });

  it('lists newest first with page arithmetic and an optional tenant filter', async () => {
    const query = leanQuery([userDocument()]);
    const model = {
      find: jest.fn(() => query),
      countDocuments: jest.fn().mockResolvedValue(31),
    };
    const repository = new MongoosePanelUserRepository({ model });

    const result = await repository.list({ tenantKey: 'sap_integration_acme', page: 3, pageSize: 10 });

    expect(model.find).toHaveBeenCalledWith({ tenantKey: 'sap_integration_acme' });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(query.skip).toHaveBeenCalledWith(20);
    expect(query.limit).toHaveBeenCalledWith(10);
    expect(result.total).toBe(31);
    expect(result.items[0].id).toBe(USER_ID);

    await repository.list({ tenantKey: null, page: 1, pageSize: 25 });
    expect(model.find).toHaveBeenLastCalledWith({});
  });
});

describe('SaaSClientTenantDirectory', () => {
  it('only projects tenantKey, companyName and status', async () => {
    const query = leanQuery({
      tenantKey: 'sap_integration_acme',
      companyName: 'Acme',
      status: 'active',
    });
    const model = { findOne: jest.fn(() => query) };
    const directory = new SaaSClientTenantDirectory({ model });

    const tenant = await directory.findByKey('sap_integration_acme');

    expect(query.select).toHaveBeenCalledWith('tenantKey companyName status');
    expect(tenant).toEqual({ tenantKey: 'sap_integration_acme', companyName: 'Acme', status: 'active' });
  });

  it('never returns other SaaSClient fields even if the query leaks them', async () => {
    const model = {
      findOne: jest.fn(() => leanQuery({
        tenantKey: 'sap_integration_acme',
        companyName: 'Acme',
        status: 'active',
        hubspot: { accessToken: 'secret' },
      })),
    };
    const directory = new SaaSClientTenantDirectory({ model });

    const tenant = await directory.findByKey('sap_integration_acme');

    expect(tenant).not.toHaveProperty('hubspot');
  });

  it('looks up many tenants at once and skips empty keys', async () => {
    const query = leanQuery([{ tenantKey: 'a', companyName: 'A', status: 'active' }]);
    const model = { find: jest.fn(() => query) };
    const directory = new SaaSClientTenantDirectory({ model });

    await expect(directory.findManyByKeys([null, 'a', 'a'])).resolves.toHaveLength(1);
    expect(model.find).toHaveBeenCalledWith({ tenantKey: { $in: ['a'] } });
    await expect(directory.findManyByKeys([null])).resolves.toEqual([]);
    expect(model.find).toHaveBeenCalledTimes(1);
  });

  it('lists every tenant, suspended included, sorted by company name', async () => {
    const query = leanQuery([
      { tenantKey: 'a', companyName: 'A', status: 'active' },
      { tenantKey: 'b', companyName: 'B', status: 'suspended' },
    ]);
    const model = { find: jest.fn(() => query) };
    const directory = new SaaSClientTenantDirectory({ model });

    const tenants = await directory.listAll();

    expect(model.find).toHaveBeenCalledWith({});
    expect(query.sort).toHaveBeenCalledWith({ companyName: 1 });
    expect(tenants.map((tenant) => tenant.status)).toEqual(['active', 'suspended']);
  });
});

describe('PanelUser schema (validation only, no database)', () => {
  let PanelUser;

  beforeAll(async () => {
    ({ default: PanelUser } = await import('../../../src/infrastructure/database/models/global/PanelUser.js'));
  });

  function build(overrides = {}) {
    return new PanelUser({
      email: '  Ana@Acme.TEST ',
      name: 'Ana',
      accountType: 'cliente',
      tenantKey: 'SAP_INTEGRATION_ACME',
      role: 'admin',
      passwordHash: 'scrypt$hash',
      ...overrides,
    });
  }

  it('normalizes email and tenantKey and applies the defaults', async () => {
    const user = build();

    await expect(user.validate()).resolves.toBeUndefined();
    expect(user.email).toBe('ana@acme.test');
    expect(user.tenantKey).toBe('sap_integration_acme');
    expect(user.mustChangePassword).toBe(true);
    expect(user.active).toBe(true);
    expect(user.tokenVersion).toBe(0);
    expect(user.collection.collectionName).toBe('PanelUsers');
  });

  it.each([
    ['a cliente without tenantKey', { tenantKey: null }],
    ['a cliente without role', { role: null }],
    ['a smarteam account with tenantKey', { accountType: 'smarteam', role: null }],
    ['a smarteam account with role', { accountType: 'smarteam', tenantKey: null }],
    ['an unknown role', { role: 'jefe' }],
    ['an unknown account type', { accountType: 'otro' }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(build(overrides).validate()).rejects.toThrow();
  });

  it('accepts a smarteam account without tenantKey or role', async () => {
    await expect(build({ accountType: 'smarteam', tenantKey: null, role: null }).validate())
      .resolves.toBeUndefined();
  });

  it('declares the unique email index and the tenant listing index', () => {
    const indexes = PanelUser.schema.indexes().map(([fields, options]) => ({ fields, unique: Boolean(options?.unique) }));

    expect(indexes).toEqual(expect.arrayContaining([
      { fields: { email: 1 }, unique: true },
      { fields: { tenantKey: 1, createdAt: -1 }, unique: false },
    ]));
  });
});
