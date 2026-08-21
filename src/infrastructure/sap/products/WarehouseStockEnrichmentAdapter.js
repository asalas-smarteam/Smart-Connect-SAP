import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import {
  B1_STOCK_METRICS,
  WAREHOUSE_METRIC_INVALID_WARNING,
  WAREHOUSE_STOCK_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';
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
    // Opcional a proposito: sin el, el enrich sigue funcionando y el aviso solo
    // queda en el log. Se cablea en sap-sync.composition.js.
    syncWarningRepository = null,
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
    this.syncWarningRepository = syncWarningRepository;
    this.logger = logger;
  }

  async enrich({
    mappedRecords,
    objectType,
    tenantModels,
    clientConfigId = null,
    syncLogId = null,
  }) {
    if (objectType !== 'product' || !tenantModels) {
      return;
    }

    const records = Array.isArray(mappedRecords) ? mappedRecords : [];

    try {
      const { strategyName, rawFields, rawExclusions } = await this.configRepository
        .getWarehouseStockConfig({ tenantModels });
      const strategy = this.strategyFactory.getStrategy(strategyName);

      // Se juntan acá y se reportan ANTES del return temprano de
      // fields.length === 0: si todas las entradas del tenant estan mal
      // escritas, fields queda vacio y ese return se llevaria puesto el aviso,
      // que es justo el caso donde mas se necesita.
      const invalidMetricFields = [];
      const fields = strategy.normalizeFields(rawFields, {
        onInvalidMetric: (entry) => invalidMetricFields.push(entry),
      });
      const exclusions = strategy.normalizeExclusions(rawExclusions);

      await this.recordInvalidMetricWarnings({
        invalidMetricFields,
        tenantModels,
        clientConfigId,
        syncLogId,
      });

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

  // Un documento de SyncWarnings por entrada mal configurada, una vez por
  // corrida y no una por producto.
  //
  // El try/catch por iteracion no es redundante con el que envuelve a enrich:
  // este metodo corre ANTES del bucle que escribe las propiedades, asi que un
  // fallo al registrar el aviso que subiera hasta el catch de enrich se
  // llevaria puesto el enriquecimiento de las entradas que SI estan bien.
  // MongooseSyncWarningRepository.record ya resuelve null ante cualquier fallo;
  // esto cubre un repositorio inyectado que no lo haga.
  async recordInvalidMetricWarnings({
    invalidMetricFields,
    tenantModels,
    clientConfigId,
    syncLogId,
  }) {
    if (invalidMetricFields.length === 0) {
      return;
    }

    this.logger.error?.('Warehouse stock metric not supported', {
      invalidMetricFields,
    });

    if (typeof this.syncWarningRepository?.record !== 'function') {
      return;
    }

    for (const { propertyName, warehouseCode, metric } of invalidMetricFields) {
      try {
        await this.syncWarningRepository.record({
          tenantModels,
          clientConfigId,
          syncLogId,
          objectType: 'product',
          // La config es del tenant, no de un producto puntual.
          sapId: null,
          code: WAREHOUSE_METRIC_INVALID_WARNING,
          message: `Warehouse stock metric not supported: "${metric}"`,
          details: {
            propertyName,
            warehouseCode,
            metric,
            validMetrics: Object.values(B1_STOCK_METRICS),
          },
        });
      } catch (error) {
        this.logger.error?.('Warehouse stock metric warning not recorded', {
          propertyName,
          error: error?.message,
        });
      }
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
