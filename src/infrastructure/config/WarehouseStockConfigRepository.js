import {
  DEFAULT_WAREHOUSE_STOCK_STRATEGY,
  WAREHOUSE_STOCK_CONFIG_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';

// Same key B1 tenants already use; only the interpretation of valueSAP
// changes per strategy (see strategies/*.js). Reusing it means an existing
// tenant's admin UI keeps working unmodified.
export const WAREHOUSE_FIELDS_CONFIG_KEY = 'fieldsWareHouseHS';
export const EXCLUDED_WAREHOUSES_CONFIG_KEY = 'excludedWarehouses';

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

export class WarehouseStockConfigRepository {
  // Never throws: a config read failure must not stop a product sync, it
  // just means no warehouse-stock properties get written this run. Reads
  // directly with findOne (no upsert-on-missing like tenantConfiguration
  // .service.js's getValue), so a tenant that has not configured any of this
  // does not get empty documents created for it.
  async getWarehouseStockConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const [strategyConfig, rawFields, rawExclusions] = await Promise.all([
        readConfiguration(Configuration, WAREHOUSE_STOCK_CONFIG_KEY),
        readConfiguration(Configuration, WAREHOUSE_FIELDS_CONFIG_KEY),
        readConfiguration(Configuration, EXCLUDED_WAREHOUSES_CONFIG_KEY),
      ]);

      const strategyName = String(strategyConfig?.strategy ?? '').trim()
        || DEFAULT_WAREHOUSE_STOCK_STRATEGY;

      return { strategyName, rawFields, rawExclusions };
    } catch (error) {
      console.error('Warehouse stock config read error:', error);
      return {
        strategyName: DEFAULT_WAREHOUSE_STOCK_STRATEGY,
        rawFields: null,
        rawExclusions: null,
      };
    }
  }
}

export default WarehouseStockConfigRepository;
