import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { WAREHOUSE_STOCK_STRATEGIES } from '#domain/warehouses/warehouse-stock-strategy.constants.js';
import S4PlantStorageLocationStrategy from '#domain/warehouses/strategies/s4-plant-storage-location.strategy.js';
import WarehouseStockConfigRepository from '#infrastructure/config/WarehouseStockConfigRepository.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import S4StockResolver from './S4StockResolver.js';

// Resolves the per-warehouse stock properties for a set of item codes (line items of a
// deal), using the same tenant configuration and S/4 strategy as the product sync but
// querying only the materials involved. Returns Map<itemCode, { [propertyName]: number }>.
//
// Returns an empty Map, with no S/4 call, when the tenant does not use the S/4
// plant/storage-location strategy or has no valid fields configured, so tenants without
// the configuration are unaffected. Errors from the S/4 call propagate: the caller decides
// how to degrade.
export class S4LineItemStockAdapter {
  constructor({
    configRepository = new WarehouseStockConfigRepository(),
    strategy = new S4PlantStorageLocationStrategy(),
    resolverFactory = null,
  } = {}) {
    this.configRepository = configRepository;
    this.strategy = strategy;
    // Overridable for tests; by default builds an S/4 stock resolver over a transport
    // created from the tenant's own SAP config (credentials and sap-client params).
    this.resolverFactory = resolverFactory
      || ((config) => new S4StockResolver({
        transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config }),
      }));
  }

  async resolveStockProperties({ sapConfig, tenantModels, itemCodes }) {
    const result = new Map();
    const codes = [...new Set(
      (Array.isArray(itemCodes) ? itemCodes : [])
        .map((code) => String(code ?? '').trim())
        .filter(Boolean)
    )];

    if (codes.length === 0) {
      return result;
    }

    const { strategyName, rawFields, rawExclusions } = await this.configRepository
      .getWarehouseStockConfig({ tenantModels });

    if (strategyName !== WAREHOUSE_STOCK_STRATEGIES.S4_PLANT_STORAGE_LOCATION) {
      return result;
    }

    const fields = this.strategy.normalizeFields(rawFields);

    if (fields.length === 0) {
      return result;
    }

    const exclusions = this.strategy.normalizeExclusions(rawExclusions);
    const targets = this.strategy.buildQueryTargets(fields)
      .map((target) => ({ ...target, materials: codes }));
    const rows = await this.resolverFactory(sapConfig).fetchStockRows(targets);
    const index = this.strategy.buildIndex(rows, { exclusions });

    for (const code of codes) {
      result.set(code, this.strategy.buildProperties({
        record: { rawSapData: { Product: code } },
        index,
        fields,
      }));
    }

    return result;
  }
}

export default S4LineItemStockAdapter;
