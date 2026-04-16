import { jest } from '@jest/globals';
import {
  buildHubspotWarehouseStockProperties,
  getAvailableStockForWarehouse,
  getHubspotWarehouseStockPropertiesForTenant,
  normalizeHubspotWarehouseFields,
  resolveHubspotWarehouseFields,
} from '../../src/utils/warehouseStock.js';

describe('warehouseStock utils', () => {
  it('normalizes tenant warehouse config and preserves property key from config value', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'fieldsWareHouseHS',
          value: [
            { label: 'Entrepiso-T1', value: 'A01_stock' },
            { label: 'PVC', value: ' B10_stock ' },
            { label: 'Duplicado', value: 'B10_stock' },
            { label: 'Inválido', value: '' },
          ],
          userUpdated: 'admin',
        }),
      },
    };

    const fields = await resolveHubspotWarehouseFields(tenantModels);

    expect(fields).toEqual([
      { warehouseCode: 'A01', propertyName: 'A01_stock' },
      { warehouseCode: 'B10', propertyName: 'B10_stock' },
    ]);
  });

  it('builds HubSpot stock properties per configured warehouse', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'fieldsWareHouseHS',
          value: [
            { label: 'Entrepiso-T1', value: 'A01_stock' },
            { label: 'PVC', value: 'B10_stock' },
            { label: 'No existe', value: 'C99_stock' },
          ],
          userUpdated: 'admin',
        }),
      },
    };

    const properties = await getHubspotWarehouseStockPropertiesForTenant(tenantModels, [
      { WarehouseCode: 'A01', Ordered: 2, Committed: 1, InStock: 7 },
      { WarehouseCode: 'B10', Ordered: 0, Committed: 3, InStock: 5 },
    ]);

    expect(properties).toEqual({
      A01_stock: 8,
      B10_stock: 2,
      C99_stock: 0,
    });
  });

  it('falls back to empty warehouse field list when config value is invalid', () => {
    expect(normalizeHubspotWarehouseFields('B10_stock')).toEqual([]);
    expect(buildHubspotWarehouseStockProperties([], null)).toEqual({});
  });

  it('returns available stock for one warehouse code without summing all warehouses', () => {
    const available = getAvailableStockForWarehouse(
      [
        { WarehouseCode: 'B04', Ordered: 1, Committed: 2, InStock: 8 },
        { WarehouseCode: 'B10', Ordered: 9, Committed: 0, InStock: 9 },
      ],
      'B04'
    );

    expect(available).toBe(7);
  });
});
