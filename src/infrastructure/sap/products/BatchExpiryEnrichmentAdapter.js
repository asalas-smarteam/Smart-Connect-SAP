import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import {
  BATCH_EXPIRY_KEY,
  BATCH_SOURCE_STRATEGIES,
} from '#domain/batches/batch-expiry.constants.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import S4StockResolver from './S4StockResolver.js';
import S4BatchResolver from './S4BatchResolver.js';

// Adjunta al rawSapData de cada producto las propiedades de lote/caducidad ya
// resueltas, antes de que product.handler.js las copie.
//
// A diferencia de WarehouseStockEnrichmentAdapter, este NO escribe la clave
// cuando algo sale mal ni cuando el tenant no maneja lotes. Escribir vacio es
// una afirmacion ("este producto no tiene lotes") y un fallo de red no la
// autoriza: dejar la clave ausente hace que el handler no toque las
// propiedades y HubSpot conserve lo de la corrida anterior.
export class BatchExpiryEnrichmentAdapter {
  constructor({
    sourceFactory,
    projectionFactory,
    configRepository,
    stockResolverFactory = null,
    batchResolverFactory = null,
    logger = console,
  }) {
    this.sourceFactory = sourceFactory;
    this.projectionFactory = projectionFactory;
    this.configRepository = configRepository;
    this.stockResolverFactory = stockResolverFactory
      || ((config) => new S4StockResolver({
        transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config }),
      }));
    this.batchResolverFactory = batchResolverFactory
      || ((config) => new S4BatchResolver({
        transport: createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config }),
        logger,
      }));
    this.logger = logger;
  }

  async enrich({ mappedRecords, objectType, tenantModels }) {
    if (objectType !== 'product' || !tenantModels) {
      return;
    }

    const records = Array.isArray(mappedRecords) ? mappedRecords : [];

    try {
      const { sourceName, projectionName, rawConfig } = await this.configRepository
        .getBatchExpiryConfig({ tenantModels });

      if (sourceName === BATCH_SOURCE_STRATEGIES.NONE) {
        return;
      }

      const strategy = this.sourceFactory.getStrategy(sourceName);
      const projection = this.projectionFactory.getStrategy(projectionName);
      const config = strategy.normalizeConfig(rawConfig);

      let index = new Map();

      if (strategy.requiresRemoteFetch()) {
        // Defensa en profundidad. Una fuente que necesita red y no produce ni
        // un target no puede traer filas, y sin filas la proyeccion escribiria
        // las siete propiedades en blanco sobre TODOS los productos. Con la
        // estrategia s4 esto ya es inalcanzable (bodegas vacias produce el
        // target explicito de todos los centros), y ese es justamente el punto:
        // una configuracion futura mal armada degrada a "no tocar HubSpot".
        const queryTargets = strategy.buildQueryTargets(config);

        if (!Array.isArray(queryTargets) || queryTargets.length === 0) {
          this.logger.error?.(
            'Batch expiry enrichment skipped: the source requires a remote fetch but produced no query targets'
          );
          return;
        }

        const sapCredentialsList = typeof tenantModels.SapCredentials?.find === 'function'
          ? await tenantModels.SapCredentials.find().lean()
          : [];
        const [sapCredentials] = sapCredentialsList;

        if (!sapCredentials) {
          this.logger.warn?.('Batch expiry enrichment skipped: no SAP credentials');
          return;
        }

        // Las dos lecturas son independientes y juntas dominan el tiempo de la
        // corrida (~1.8 s el stock, ~319 s el maestro de lotes), asi que van en
        // paralelo. Ambas corren UNA sola vez sobre el set completo, antes de
        // que processProductBatches lotee de a 100: un solo indice sirve a
        // todos los lotes.
        const [stockRows, batchRows] = await Promise.all([
          this.stockResolverFactory(sapCredentials).fetchStockRows(queryTargets),
          this.batchResolverFactory(sapCredentials).fetchBatchRows(),
        ]);

        // Un unico `now` para toda la corrida: si cada producto tomara el suyo,
        // dos productos evaluados a ambos lados de la medianoche darian
        // dias_para_vencer inconsistentes entre si.
        index = strategy.buildIndex({ stockRows, batchRows }, { config, now: new Date() });
      }

      for (const record of records) {
        if (!record?.rawSapData) {
          continue;
        }

        record.rawSapData[BATCH_EXPIRY_KEY] = projection.project({
          record,
          batches: strategy.resolveBatches({ record, index }),
          config,
        });
      }
    } catch (error) {
      this.logger.error?.('Batch expiry enrichment failed', { error: error?.message });
    }
  }
}

export default BatchExpiryEnrichmentAdapter;
