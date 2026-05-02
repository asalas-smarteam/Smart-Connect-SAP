import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createDefaultSapFilterModel } from '../../models/master/defaultSapFilter.model.js';
import { createSapFilterModel } from '../../models/tenant/sapFilter.model.js';
import { replicateDefaultSapFilters } from '../../src/services/tenant/replicateDefaultSapFilters.js';

let mongoServer;
let masterConnection;
let tenantConnection;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  const uri = mongoServer.getUri();
  masterConnection = await mongoose.createConnection(uri, { dbName: 'master_test' }).asPromise();
  tenantConnection = await mongoose.createConnection(uri, { dbName: 'tenant_test' }).asPromise();
});

afterEach(async () => {
  if (masterConnection) {
    await masterConnection.dropDatabase();
  }
  if (tenantConnection) {
    await tenantConnection.dropDatabase();
  }
});

afterAll(async () => {
  if (masterConnection) {
    await masterConnection.close();
  }
  if (tenantConnection) {
    await tenantConnection.close();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe('replicateDefaultSapFilters', () => {
  it('replicates only active defaults and avoids duplicates', async () => {
    const DefaultSapFilter = createDefaultSapFilterModel(masterConnection);
    const SapFilter = createSapFilterModel(tenantConnection);

    await DefaultSapFilter.insertMany([
      { objectType: 'Invoice', property: 'DocDueDate', operator: 'ge', value: '2025-01-01', active: true },
      { objectType: 'Invoice', property: 'CardCode', operator: 'eq', value: 'C001', active: true },
      { objectType: 'Invoice', property: 'Canceled', operator: 'eq', value: 'Y', active: false },
    ]);

    await SapFilter.create({ objectType: 'Invoice', property: 'DocDueDate', operator: 'ge', value: '2025-01-01', active: true });

    await replicateDefaultSapFilters({ masterConnection, tenantConnection });
    await replicateDefaultSapFilters({ masterConnection, tenantConnection });

    const filters = await SapFilter.find({}).lean();
    expect(filters).toHaveLength(2);
    expect(filters.map((f) => f.property).sort()).toEqual(['CardCode', 'DocDueDate']);
  });
});
