import { jest } from '@jest/globals';
import {
  getWarehouseStockTotals,
  getWarehouseStockTotalsForTenant,
  resolveExcludedWarehouses,
} from '../../src/utils/warehouseStock.js';

describe('warehouseStock utils', () => {
  it('uses excludedWarehouses tenant config when calculating totals', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'excludedWarehouses',
          value: ['b11', ' B12 '],
          userUpdated: 'admin',
        }),
      },
    };

    const totals = await getWarehouseStockTotalsForTenant(tenantModels, [
      { WarehouseCode: 'B11', Ordered: 10, Committed: 3, InStock: 7 },
      { WarehouseCode: 'B13', Ordered: 2, Committed: 1, InStock: 9 },
    ]);

    expect(totals).toEqual({
      ordered: 2,
      committed: 1,
      instock: 9,
    });
  });

  it('falls back to default excluded warehouses when config value is not an array', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'excludedWarehouses',
          value: 'B11',
          userUpdated: 'admin',
        }),
      },
    };

    const excludedWarehouses = await resolveExcludedWarehouses(tenantModels);
    const totals = getWarehouseStockTotals(
      [{ WarehouseCode: 'B11', Ordered: 10, Committed: 1, InStock: 5 }],
      excludedWarehouses
    );

    expect(excludedWarehouses).toEqual(['B11', 'B12', 'B13']);
    expect(totals).toEqual({
      ordered: 0,
      committed: 0,
      instock: 0,
    });
  });
});
