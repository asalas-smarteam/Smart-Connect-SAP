import { jest } from '@jest/globals';
import MongooseTenantConfigRepository from '../../../src/infrastructure/database/repositories/MongooseTenantConfigRepository.js';

function createClientModel(result) {
  const lean = jest.fn().mockResolvedValue(result);
  const findOne = jest.fn().mockReturnValue({ lean });

  return { findOne, lean };
}

describe('MongooseTenantConfigRepository', () => {
  it('finds active tenant by tenant id', async () => {
    const clientModel = createClientModel({ _id: 'tenant-id' });
    const repository = new MongooseTenantConfigRepository({ clientModel });

    await repository.findActiveTenant({ tenantId: 'tenant-id' });

    expect(clientModel.findOne).toHaveBeenCalledWith({
      _id: 'tenant-id',
      active: true,
    });
  });

  it('finds active tenant by tenant key', async () => {
    const clientModel = createClientModel({ tenantKey: 'tenant-key' });
    const repository = new MongooseTenantConfigRepository({ clientModel });

    await repository.findActiveTenant({ tenantKey: 'tenant-key' });

    expect(clientModel.findOne).toHaveBeenCalledWith({
      tenantKey: 'tenant-key',
      active: true,
    });
  });

  it('finds active tenant by HubSpot portal id', async () => {
    const clientModel = createClientModel({ tenantKey: 'tenant-key' });
    const repository = new MongooseTenantConfigRepository({ clientModel });

    await repository.findActiveTenant({ portalId: 123 });

    expect(clientModel.findOne).toHaveBeenCalledWith({
      'hubspot.portalId': '123',
      active: true,
    });
  });

  it('resolves tenant models through the injected resolver', async () => {
    const tenantModels = { ClientConfig: {} };
    const tenantModelResolver = jest.fn().mockResolvedValue(tenantModels);
    const repository = new MongooseTenantConfigRepository({ tenantModelResolver });

    await expect(repository.getTenantModels('tenant-key')).resolves.toBe(tenantModels);
    expect(tenantModelResolver).toHaveBeenCalledWith('tenant-key');
  });
});

