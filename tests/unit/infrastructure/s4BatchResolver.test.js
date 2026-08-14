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

  // El $select pide BatchIdentifyingPlant justamente para poder avisar: si deja
  // de ser vacio, el join Material+Batch se vuelve ambiguo y buildBatchIndex
  // (last-row-wins sobre `material|batch`) tomaria la fecha de un centro
  // arbitrario en silencio. Sin este warn, pedir el campo no servia de nada.
  it('avisa UNA sola vez por corrida si aparece un BatchIdentifyingPlant no vacio', async () => {
    const logger = { warn: jest.fn() };
    const transport = {
      fetchAll: jest.fn(async () => [
        { Material: 'X', Batch: 'L1', BatchIdentifyingPlant: 'DPDO' },
        { Material: 'X', Batch: 'L1', BatchIdentifyingPlant: 'MQDO' },
        { Material: 'Y', Batch: 'L2', BatchIdentifyingPlant: '' },
      ]),
    };

    const rows = await new S4BatchResolver({ transport, logger }).fetchBatchRows();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toEqual(expect.objectContaining({
      rowsWithPlant: 2,
      totalRows: 3,
    }));
    // El warn es una senal, no un filtro: las filas se devuelven completas.
    expect(rows).toHaveLength(3);
  });

  it('no avisa cuando BatchIdentifyingPlant viene vacio o ausente en todas las filas', async () => {
    const logger = { warn: jest.fn() };
    const transport = {
      fetchAll: jest.fn(async () => [
        { Material: 'X', Batch: 'L1', BatchIdentifyingPlant: '' },
        { Material: 'Y', Batch: 'L2', BatchIdentifyingPlant: '   ' },
        { Material: 'Z', Batch: 'L3' },
      ]),
    };

    await new S4BatchResolver({ transport, logger }).fetchBatchRows();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
