import { jest } from '@jest/globals';
import { TenantLineItemPriceConfigRepository } from '../../src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js';

function buildTenantModels(priceListValue) {
  return {
    Configuration: {
      findOneAndUpdate: jest.fn().mockImplementation(async (filter) => {
        if (filter?.key === 'priceList') {
          return { key: 'priceList', value: priceListValue, userUpdated: 'admin' };
        }

        return null;
      }),
    },
  };
}

describe('TenantLineItemPriceConfigRepository resolveTenantPriceList', () => {
  const repository = new TenantLineItemPriceConfigRepository();

  it('resolves the currency entry from the currency map', async () => {
    const tenantModels = buildTenantModels({ default: 4, GTQ: 4, USD: 5 });

    await expect(
      repository.resolveTenantPriceList({ tenantModels, currency: 'USD' })
    ).resolves.toBe(5);
  });

  it('falls back to the default entry when no currency is provided', async () => {
    const tenantModels = buildTenantModels({ default: 4, GTQ: 4, USD: 5 });

    await expect(repository.resolveTenantPriceList({ tenantModels })).resolves.toBe(4);
  });

  it('rejects the legacy scalar format', async () => {
    const tenantModels = buildTenantModels('4');

    await expect(repository.resolveTenantPriceList({ tenantModels })).rejects.toThrow(
      'Configuration priceList must be a currency map'
    );
  });

  it('throws when the map has no resolvable entry', async () => {
    const tenantModels = buildTenantModels({ USD: 'abc' });

    await expect(
      repository.resolveTenantPriceList({ tenantModels, currency: 'USD' })
    ).rejects.toThrow('Configuration priceList must be a currency map');
  });

  it('throws when the configuration is missing', async () => {
    const tenantModels = buildTenantModels(null);

    await expect(repository.resolveTenantPriceList({ tenantModels })).rejects.toThrow(
      'Configuration priceList must be a currency map'
    );
  });
});
