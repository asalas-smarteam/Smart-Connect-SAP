import { jest } from '@jest/globals';
import BatchExpiryEnrichmentAdapter from '../../../src/infrastructure/sap/products/BatchExpiryEnrichmentAdapter.js';
import { BATCH_EXPIRY_KEY, BATCH_SOURCE_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';
import { SapRecordEnricherPort } from '../../../src/application/ports/sap/sap-record-enricher.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const STOCK_ROWS = [{ Material: '1', Batch: 'L1' }];
const BATCH_ROWS = [{ Material: '1', Batch: 'L1' }];

function buildAdapter({
  sourceName = BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER,
  strategy,
  projection,
  stockResolver,
  batchResolver,
  logger = { error: jest.fn(), warn: jest.fn() },
  credentials = [{ baseUrl: 'https://sap', user: 'u' }],
} = {}) {
  const resolvedStrategy = strategy ?? {
    normalizeConfig: jest.fn((raw) => ({ normalized: true, raw })),
    requiresRemoteFetch: jest.fn(() => true),
    buildQueryTargets: jest.fn(() => [{ plant: 'DPDO', storageLocations: null }]),
    buildIndex: jest.fn(() => new Map([['1', [{ batch: 'L1' }]]])),
    resolveBatches: jest.fn(() => [{ batch: 'L1' }]),
  };
  const resolvedProjection = projection ?? { requiredProperties: jest.fn(() => []), project: jest.fn(() => ({ lotes_detalle: 'L1' })) };

  const adapter = new BatchExpiryEnrichmentAdapter({
    sourceFactory: { getStrategy: jest.fn(() => resolvedStrategy) },
    projectionFactory: { getStrategy: jest.fn(() => resolvedProjection) },
    configRepository: { getBatchExpiryConfig: jest.fn(async () => ({ sourceName, projectionName: 'hs_ProductProperties', rawConfig: {} })) },
    stockResolverFactory: () => stockResolver ?? { fetchStockRows: jest.fn(async () => STOCK_ROWS) },
    batchResolverFactory: () => batchResolver ?? { fetchBatchRows: jest.fn(async () => BATCH_ROWS) },
    logger,
  });

  const tenantModels = { SapCredentials: { find: () => ({ lean: async () => credentials }) } };
  return { adapter, tenantModels, strategy: resolvedStrategy, projection: resolvedProjection, logger };
}

function buildRecords() {
  return [{ rawSapData: { Product: '1' } }, { rawSapData: { Product: '2' } }];
}

describe('BatchExpiryEnrichmentAdapter', () => {
  it('cumple el puerto de enricher', () => {
    expect(() => assertPort(buildAdapter().adapter, SapRecordEnricherPort)).not.toThrow();
  });

  it('escribe la clave con las propiedades proyectadas', async () => {
    const { adapter, tenantModels } = buildAdapter();
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(records[0].rawSapData[BATCH_EXPIRY_KEY]).toEqual({ lotes_detalle: 'L1' });
  });

  it('inyecta un now unico a toda la corrida, no uno por producto', async () => {
    const { adapter, tenantModels, strategy } = buildAdapter();
    await adapter.enrich({ mappedRecords: buildRecords(), objectType: 'product', tenantModels });

    expect(strategy.buildIndex).toHaveBeenCalledTimes(1);
    expect(strategy.buildIndex.mock.calls[0][1].now).toBeInstanceOf(Date);
  });

  it('no hace nada en un sync que no es de productos', async () => {
    const { adapter, tenantModels } = buildAdapter();
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('source none: ni una llamada a SAP y NO escribe la clave', async () => {
    const stockResolver = { fetchStockRows: jest.fn() };
    const { adapter, tenantModels } = buildAdapter({ sourceName: BATCH_SOURCE_STRATEGIES.NONE, stockResolver });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(stockResolver.fetchStockRows).not.toHaveBeenCalled();
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('sin credenciales SAP avisa y NO escribe la clave', async () => {
    const { adapter, tenantModels, logger } = buildAdapter({ credentials: [] });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(logger.warn).toHaveBeenCalled();
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('un fallo del resolver se traga con logger.error y NO pisa propiedades', async () => {
    const batchResolver = { fetchBatchRows: jest.fn(async () => { throw new Error('gateway 500'); }) };
    const { adapter, tenantModels, logger } = buildAdapter({ batchResolver });
    const records = buildRecords();

    await adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels });

    expect(logger.error).toHaveBeenCalledWith('Batch expiry enrichment failed', expect.objectContaining({ error: 'gateway 500' }));
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('una estrategia desconocida se traga igual', async () => {
    const adapter = new BatchExpiryEnrichmentAdapter({
      sourceFactory: { getStrategy: () => { throw new Error('Batch source strategy not supported: xx'); } },
      projectionFactory: { getStrategy: jest.fn() },
      configRepository: { getBatchExpiryConfig: async () => ({ sourceName: 'xx', projectionName: 'y', rawConfig: {} }) },
      logger: { error: jest.fn() },
    });
    const records = buildRecords();

    await expect(adapter.enrich({ mappedRecords: records, objectType: 'product', tenantModels: {} })).resolves.toBeUndefined();
    expect(records[0].rawSapData).not.toHaveProperty(BATCH_EXPIRY_KEY);
  });

  it('salta registros sin rawSapData sin romperse', async () => {
    const { adapter, tenantModels } = buildAdapter();
    await expect(adapter.enrich({ mappedRecords: [null, {}], objectType: 'product', tenantModels })).resolves.toBeUndefined();
  });

  it('pide el stock UNA vez y el maestro UNA vez para todo el lote de productos', async () => {
    const stockResolver = { fetchStockRows: jest.fn(async () => STOCK_ROWS) };
    const batchResolver = { fetchBatchRows: jest.fn(async () => BATCH_ROWS) };
    const { adapter, tenantModels } = buildAdapter({ stockResolver, batchResolver });

    await adapter.enrich({ mappedRecords: buildRecords(), objectType: 'product', tenantModels });

    expect(stockResolver.fetchStockRows).toHaveBeenCalledTimes(1);
    expect(batchResolver.fetchBatchRows).toHaveBeenCalledTimes(1);
  });
});
