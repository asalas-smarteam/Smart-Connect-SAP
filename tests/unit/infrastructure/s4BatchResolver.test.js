import { jest } from '@jest/globals';
import { S4BatchResolver, BATCH_MASTER_PATH, BATCH_MASTER_SELECT } from '../../../src/infrastructure/sap/products/S4BatchResolver.js';

describe('S4BatchResolver', () => {
  it('exige un transport', () => {
    expect(() => new S4BatchResolver({})).toThrow('transport is required');
  });

  it('trae el maestro completo en UNA sola conversacion (no una por centro)', async () => {
    const transport = { fetchAll: jest.fn(async () => [{ Material: '10000289', Batch: '17131' }]) };
    const resolver = new S4BatchResolver({ transport });

    const rows = await resolver.fetchBatchRows();

    // El maestro de lotes no tiene centro -- BatchIdentifyingPlant es "" en los
    // 74,277 lotes de este sistema -- asi que particionarlo por Plant seria
    // imposible y por material seria el N+1 que S4ContactResolver ya evito.
    expect(transport.fetchAll).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ Material: '10000289', Batch: '17131' }]);
  });

  it('usa la ruta y el $select exactos, sin $filter', async () => {
    const transport = { fetchAll: jest.fn(async () => []) };
    await new S4BatchResolver({ transport }).fetchBatchRows();

    const call = transport.fetchAll.mock.calls[0][0];
    expect(call.path).toBe(BATCH_MASTER_PATH);
    expect(call.query.$select).toBe(BATCH_MASTER_SELECT);
    expect(call.query.$filter).toBeUndefined();
  });

  it('el $select trae material, lote y las dos fechas', () => {
    expect(BATCH_MASTER_SELECT.split(',')).toEqual([
      'Material', 'BatchIdentifyingPlant', 'Batch', 'ShelfLifeExpirationDate', 'ManufactureDate',
    ]);
  });

  it('descarta filas nulas que pueda devolver la paginacion', async () => {
    const transport = { fetchAll: jest.fn(async () => [null, { Material: 'X', Batch: 'L' }]) };
    expect(await new S4BatchResolver({ transport }).fetchBatchRows()).toEqual([{ Material: 'X', Batch: 'L' }]);
  });
});
