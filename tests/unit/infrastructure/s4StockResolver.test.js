import { jest } from '@jest/globals';
import { S4StockResolver, MATERIAL_STOCK_PATH, MATERIAL_STOCK_SELECT } from '../../../src/infrastructure/sap/products/S4StockResolver.js';

function buildTransport(rowsByPlant = {}) {
  return {
    fetchAll: jest.fn(async ({ query }) => {
      const filter = decodeURIComponent(query.$filter);
      const match = filter.match(/Plant eq '([^']+)'/);
      return rowsByPlant[match?.[1]] ?? [];
    }),
  };
}

describe('S4StockResolver', () => {
  it('requires a transport', () => {
    expect(() => new S4StockResolver({})).toThrow('transport is required');
  });

  it('returns [] and makes no calls when there are no targets', async () => {
    const transport = buildTransport();
    const resolver = new S4StockResolver({ transport });

    expect(await resolver.fetchStockRows([])).toEqual([]);
    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  it('fetches exactly once per plant, never per material (no N+1)', async () => {
    const transport = buildTransport({
      MQGT: [{ Material: '1001' }],
      DPDO: [{ Material: '1002' }],
    });
    const resolver = new S4StockResolver({ transport });

    const rows = await resolver.fetchStockRows([
      { plant: 'MQGT', storageLocations: ['0008', '0500'] },
      { plant: 'DPDO', storageLocations: null },
    ]);

    expect(transport.fetchAll).toHaveBeenCalledTimes(2);
    expect(rows).toEqual([{ Material: '1001' }, { Material: '1002' }]);
  });

  it('uses the exact path and $select', async () => {
    const transport = buildTransport({ MQGT: [] });
    const resolver = new S4StockResolver({ transport });

    await resolver.fetchStockRows([{ plant: 'MQGT', storageLocations: null }]);

    const call = transport.fetchAll.mock.calls[0][0];
    expect(call.path).toBe(MATERIAL_STOCK_PATH);
    expect(call.query.$select).toBe(MATERIAL_STOCK_SELECT);
  });

  it('pide Batch: la estrategia de lotes hace el join contra el maestro con el', () => {
    expect(MATERIAL_STOCK_SELECT.split(',')).toContain('Batch');
  });

  it('renders an explicit storage-location list as an OR group, plant-scoped', async () => {
    const transport = buildTransport({ MQGT: [] });
    const resolver = new S4StockResolver({ transport });

    await resolver.fetchStockRows([{ plant: 'MQGT', storageLocations: ['0008', '0500'] }]);

    const call = transport.fetchAll.mock.calls[0][0];
    expect(decodeURIComponent(call.query.$filter)).toBe(
      "Plant eq 'MQGT' and (StorageLocation eq '0008' or StorageLocation eq '0500') and MatlWrhsStkQtyInMatlBaseUnit gt 0"
    );
  });

  it('omits the storage-location clause for a whole-plant (wildcard) target', async () => {
    const transport = buildTransport({ DPDO: [] });
    const resolver = new S4StockResolver({ transport });

    await resolver.fetchStockRows([{ plant: 'DPDO', storageLocations: null }]);

    const call = transport.fetchAll.mock.calls[0][0];
    expect(decodeURIComponent(call.query.$filter)).toBe(
      "Plant eq 'DPDO' and MatlWrhsStkQtyInMatlBaseUnit gt 0"
    );
  });

  it('ignores targets with no plant', async () => {
    const transport = buildTransport();
    const resolver = new S4StockResolver({ transport });

    await resolver.fetchStockRows([{ storageLocations: ['0008'] }, null]);

    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  // "bodegas vacias = todas" de la config de lotes llega hasta aca: un target
  // marcado allPlants pide el stock de TODOS los centros en una sola consulta.
  // Medido contra el S/4 de QA el 2026-08-13: 10,125 filas en ~1 s.
  it('renders a Plant-less filter for an explicit all-plants target', async () => {
    const transport = { fetchAll: jest.fn(async () => []) };
    const resolver = new S4StockResolver({ transport });

    await resolver.fetchStockRows([{ plant: null, storageLocations: null, allPlants: true }]);

    expect(transport.fetchAll).toHaveBeenCalledTimes(1);
    const call = transport.fetchAll.mock.calls[0][0];
    expect(decodeURIComponent(call.query.$filter)).toBe('MatlWrhsStkQtyInMatlBaseUnit gt 0');
    expect(decodeURIComponent(call.query.$filter)).not.toContain('Plant');
    expect(call.path).toBe(MATERIAL_STOCK_PATH);
    expect(call.query.$select).toBe(MATERIAL_STOCK_SELECT);
  });

  // El marcador es explicito a proposito: "sin plant" NO significa "todos".
  // Confundirlos convertiria cualquier config malformada del feature de stock
  // por bodega en un escaneo completo de A_MatlStkInAcctMod.
  it('still ignores plant-less targets that do not carry the all-plants marker', async () => {
    const transport = { fetchAll: jest.fn(async () => []) };
    const resolver = new S4StockResolver({ transport });

    await resolver.fetchStockRows([
      { plant: null, storageLocations: null },
      { plant: '', storageLocations: null, allPlants: false },
      { storageLocations: ['0008'] },
    ]);

    expect(transport.fetchAll).not.toHaveBeenCalled();
  });
});
