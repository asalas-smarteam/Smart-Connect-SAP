import { jest } from '@jest/globals';
import TenantContextService from '../../../src/application/services/tenant-context.service.js';
import { TenantContextResolutionError } from '../../../src/shared/errors/index.js';

describe('TenantContextService', () => {
  it('resolves tenant context through the tenant config repository', async () => {
    const tenantModels = { ClientConfig: {} };
    const tenantConfigRepository = {
      findActiveTenant: jest.fn().mockResolvedValue({
        _id: 'tenant-id',
        tenantKey: 'tenant-key',
        companyName: 'Tenant',
      }),
      getTenantModels: jest.fn().mockResolvedValue(tenantModels),
    };
    const service = new TenantContextService({ tenantConfigRepository });

    const context = await service.resolve({ tenantId: 'tenant-id' });

    expect(tenantConfigRepository.findActiveTenant).toHaveBeenCalledWith({
      tenantId: 'tenant-id',
      tenantKey: undefined,
      portalId: undefined,
    });
    expect(tenantConfigRepository.getTenantModels).toHaveBeenCalledWith('tenant-key');
    expect(context).toEqual({
      client: {
        _id: 'tenant-id',
        tenantKey: 'tenant-key',
        companyName: 'Tenant',
      },
      tenantId: 'tenant-id',
      tenantKey: 'tenant-key',
      tenantModels,
    });
  });

  it('fails when no repository is provided', () => {
    expect(() => new TenantContextService()).toThrow(TenantContextResolutionError);
  });

  it('fails when the tenant cannot be resolved', async () => {
    const service = new TenantContextService({
      tenantConfigRepository: {
        findActiveTenant: jest.fn().mockResolvedValue(null),
        getTenantModels: jest.fn(),
      },
    });

    await expect(service.resolve({ portalId: 'portal-id' })).rejects.toThrow(
      TenantContextResolutionError
    );
  });

  it('fails when the resolved tenant does not have a tenant key', async () => {
    const service = new TenantContextService({
      tenantConfigRepository: {
        findActiveTenant: jest.fn().mockResolvedValue({ _id: 'tenant-id' }),
        getTenantModels: jest.fn(),
      },
    });

    await expect(service.resolve({ tenantId: 'tenant-id' })).rejects.toThrow(
      TenantContextResolutionError
    );
  });
});

