import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { WAREHOUSE_STOCK_KEY } from '#domain/warehouses/warehouse-stock-strategy.constants.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import S4StockResolver from './S4StockResolver.js';

// Attaches each product's resolved warehouse-stock HubSpot properties to
// rawSapData, ahead of product.handler.js -- same shape as
// S4ContactEnrichmentAdapter (enrich a mapped record set in place, fail in
// silence so a broken config never aborts the product sync).
//
// Strategy-agnostic on purpose: whether stock is embedded (B1) or lives in a
// separate OData service keyed by Plant+StorageLocation (S/4) is entirely the
// strategy's problem. This adapter only drives the shared
// WarehouseStockStrategyPort contract.
export class WarehouseStockEnrichmentAdapter {
  constructor({
    strategyFactory,
    configRepository,
    resolverFactory = null,
    logger = console,
  }) {
    this.strategyFactory = strategyFactory;
    this.configRepository = configRepository;
    // Overridable for tests; by default builds an S/4 stock resolver over a
    // transport created from the tenant's own SAP credentials.
    this.resolverFactory = resolverFactory
      || ((config) => new S4StockResolver({
        transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config }),
      }));
    this.logger = logger;
  }

  async enrich({ mappedRecords, objectType, tenantModels }) {
    if (objectType !== 'product' || !tenantModels) {
      return;
    }

    const records = Array.isArray(mappedRecords) ? mappedRecords : [];

    try {
      const { strategyName, rawFields, rawExclusions } = await this.configRepository
        .getWarehouseStockConfig({ tenantModels });
      const strategy = this.strategyFactory.getStrategy(strategyName);

      const fields = strategy.normalizeFields(rawFields);
      const exclusions = strategy.normalizeExclusions(rawExclusions);

      if (fields.length === 0) {
        // No warehouses configured: every record still gets the key, as {} --
        // "no warehouses configured" must be distinguishable from "the
        // enricher never ran", or product.handler.js could fall back to
        // reading raw B1 fields on an S/4 tenant.
        this.applyToAllRecords(records, {});
        return;
      }

      let index = new Map();

      if (strategy.requiresRemoteFetch()) {
        const sapCredentialsList = typeof tenantModels.SapCredentials?.find === 'function'
          ? await tenantModels.SapCredentials.find().lean()
          : [];
        const [sapCredentials] = sapCredentialsList;

        if (!sapCredentials) {
          this.logger.warn?.('Warehouse stock enrichment skipped: no SAP credentials');
          this.applyToAllRecords(records, {});
          return;
        }

        const resolver = this.resolverFactory(sapCredentials);
        const targets = strategy.buildQueryTargets(fields, exclusions);
        const rows = await resolver.fetchStockRows(targets);
        index = strategy.buildIndex(rows, { exclusions });
      }

      for (const record of records) {
        if (!record?.rawSapData) {
          continue;
        }

        record.rawSapData[WAREHOUSE_STOCK_KEY] = strategy.buildProperties({
          record,
          index,
          fields,
          exclusions,
        });
      }
    } catch (error) {
      // A broken config (unknown strategy name, resolver/transport failure)
      // must not abort the product sync -- name and price still reach
      // HubSpot, just without warehouse stock for this run.
      this.logger.error?.('Warehouse stock enrichment failed', { error: error?.message });
    }
  }

  applyToAllRecords(records, value) {
    for (const record of records) {
      if (!record?.rawSapData) {
        continue;
      }

      record.rawSapData[WAREHOUSE_STOCK_KEY] = { ...value };
    }
  }
}

export default WarehouseStockEnrichmentAdapter;
