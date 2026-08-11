import { jest } from '@jest/globals';
import WarehouseStockConfigRepository, {
  EXCLUDED_WAREHOUSES_CONFIG_KEY,
  WAREHOUSE_FIELDS_CONFIG_KEY,
} from '../../../src/infrastructure/config/WarehouseStockConfigRepository.js';
import { WAREHOUSE_STOCK_CONFIG_KEY } from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';

function models(values) {
  return {
    Configuration: {
      findOne: jest.fn(({ key }) => ({
        lean: async () => (Object.prototype.hasOwnProperty.call(values, key) ? { key, value: values[key] } : null),
      })),
    },
  };
}

describe('WarehouseStockConfigRepository', () => {
  const repository = new WarehouseStockConfigRepository();

  it('defaults to the B1 strategy with no fields/exclusions when nothing is configured', async () => {
    await expect(repository.getWarehouseStockConfig({ tenantModels: models({}) }))
      .resolves.toEqual({ strategyName: 'b1_ItemWarehouse', rawFields: null, rawExclusions: null });
  });

  it('reads the configured strategy, fields and exclusions', async () => {
    const rawFields = [{ label: 'MQGT 0008', value: 'mqgt_0008_stock', valueSAP: 'MQGT/0008' }];
    const rawExclusions = ['MQGT/0006'];

    await expect(repository.getWarehouseStockConfig({
      tenantModels: models({
        [WAREHOUSE_STOCK_CONFIG_KEY]: { strategy: 's4_PlantStorageLocation' },
        [WAREHOUSE_FIELDS_CONFIG_KEY]: rawFields,
        [EXCLUDED_WAREHOUSES_CONFIG_KEY]: rawExclusions,
      }),
    })).resolves.toEqual({ strategyName: 's4_PlantStorageLocation', rawFields, rawExclusions });
  });

  it('reads with a plain findOne per key and never upserts (unlike tenantConfiguration.service.getValue)', async () => {
    const tenantModels = models({});

    await repository.getWarehouseStockConfig({ tenantModels });

    expect(tenantModels.Configuration.findOne).toHaveBeenCalledTimes(3);
    expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: WAREHOUSE_STOCK_CONFIG_KEY });
    expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: WAREHOUSE_FIELDS_CONFIG_KEY });
    expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: EXCLUDED_WAREHOUSES_CONFIG_KEY });
  });

  it('falls back to the default strategy when the read throws', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tenantModels = {
      Configuration: { findOne: jest.fn(() => { throw new Error('mongo down'); }) },
    };

    await expect(repository.getWarehouseStockConfig({ tenantModels }))
      .resolves.toEqual({ strategyName: 'b1_ItemWarehouse', rawFields: null, rawExclusions: null });

    consoleError.mockRestore();
  });

  it('accepts a tenantContext instead of tenantModels', async () => {
    await expect(repository.getWarehouseStockConfig({
      tenantContext: { tenantModels: models({ [WAREHOUSE_STOCK_CONFIG_KEY]: { strategy: 'x' } }) },
    })).resolves.toMatchObject({ strategyName: 'x' });
  });
});
