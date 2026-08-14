import { jest } from '@jest/globals';
import BatchExpiryConfigRepository from '../../../src/infrastructure/config/BatchExpiryConfigRepository.js';
import { BATCH_SOURCE_STRATEGIES, BATCH_PROJECTION_STRATEGIES } from '../../../src/domain/batches/batch-expiry.constants.js';

function buildTenantModels(value) {
  return {
    Configuration: {
      findOne: jest.fn(() => ({ lean: async () => (value === undefined ? null : { value }) })),
    },
  };
}

const repository = new BatchExpiryConfigRepository();

describe('BatchExpiryConfigRepository', () => {
  it('lee la configuracion del tenant', async () => {
    const tenantModels = buildTenantModels({
      source: 's4_BatchMaster', projection: 'hs_ProductProperties', warehouses: ['DPDO/*'],
    });

    const result = await repository.getBatchExpiryConfig({ tenantModels });

    expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: 'batchExpiryStrategy' });
    expect(result.sourceName).toBe(BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER);
    expect(result.projectionName).toBe(BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES);
    expect(result.rawConfig).toEqual({
      source: 's4_BatchMaster', projection: 'hs_ProductProperties', warehouses: ['DPDO/*'],
    });
  });

  it('sin documento cae al default none: cero impacto en los tenants B1', async () => {
    const result = await repository.getBatchExpiryConfig({ tenantModels: buildTenantModels(undefined) });
    expect(result.sourceName).toBe(BATCH_SOURCE_STRATEGIES.NONE);
    expect(result.rawConfig).toBeNull();
  });

  it('usa findOne directo, nunca un upsert que cree documentos vacios', async () => {
    const tenantModels = buildTenantModels(undefined);
    await repository.getBatchExpiryConfig({ tenantModels });
    expect(tenantModels.Configuration.findOne).toHaveBeenCalledTimes(1);
  });

  it('acepta el modelo por tenantContext ademas de por tenantModels', async () => {
    const tenantModels = buildTenantModels({ source: 's4_BatchMaster' });
    const result = await repository.getBatchExpiryConfig({ tenantContext: { tenantModels } });
    expect(result.sourceName).toBe(BATCH_SOURCE_STRATEGIES.S4_BATCH_MASTER);
  });

  it('NUNCA lanza: un error de lectura devuelve el default', async () => {
    const tenantModels = {
      Configuration: { findOne: jest.fn(() => { throw new Error('mongo caido'); }) },
    };

    const result = await repository.getBatchExpiryConfig({ tenantModels });

    expect(result).toEqual({
      sourceName: BATCH_SOURCE_STRATEGIES.NONE,
      projectionName: BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES,
      rawConfig: null,
    });
  });

  it('sin modelo Configuration devuelve el default', async () => {
    expect((await repository.getBatchExpiryConfig({})).sourceName).toBe(BATCH_SOURCE_STRATEGIES.NONE);
  });
});
