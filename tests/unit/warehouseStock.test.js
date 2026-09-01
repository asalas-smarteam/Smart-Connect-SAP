import { jest } from '@jest/globals';
import {
  buildHubspotWarehouseStockProperties,
  getAvailableStockForWarehouse,
  getHubspotWarehouseStockPropertiesForTenant,
  normalizeHubspotWarehouseFields,
  resolveHubspotAvailableFormula,
  resolveHubspotWarehouseFields,
} from '../../src/infrastructure/hubspot/warehouseStock.js';

// Responde por clave, como una coleccion real: la clave que no esta devuelve
// null y getValue cae al default que le pasaron.
function buildTenantModels(valuesByKey) {
  return {
    Configuration: {
      findOneAndUpdate: jest.fn(async ({ key }) => (
        Object.prototype.hasOwnProperty.call(valuesByKey, key)
          ? { key, value: valuesByKey[key], userUpdated: 'admin' }
          : null
      )),
    },
  };
}

describe('warehouseStock utils', () => {
  it('normalizes tenant warehouse config and preserves property key from config value', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'Entrepiso-T1', value: 'A01_stock' },
        { label: 'PVC', value: ' B10_stock ' },
        { label: 'Duplicado', value: 'B10_stock' },
        { label: 'Inválido', value: '' },
      ],
    });

    const fields = await resolveHubspotWarehouseFields(tenantModels);

    expect(fields).toEqual([
      { warehouseCode: 'A01', propertyName: 'A01_stock', metric: 'available' },
      { warehouseCode: 'B10', propertyName: 'B10_stock', metric: 'available' },
    ]);
  });

  it('uses valueSAP as warehouse code and keeps value as the HubSpot property name', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'DISTELSA', value: 'distelsa_stock', valueSAP: '01' },
        { label: 'PRODUCTOS DE EXHIBICION', value: 'exhibicion_stock', valueSAP: '05' },
      ],
    });

    const fields = await resolveHubspotWarehouseFields(tenantModels);

    expect(fields).toEqual([
      { warehouseCode: '01', propertyName: 'distelsa_stock', metric: 'available' },
      { warehouseCode: '05', propertyName: 'exhibicion_stock', metric: 'available' },
    ]);
  });

  it('builds stock properties for numeric SAP warehouse codes mapped via valueSAP', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'DISTELSA', value: 'distelsa_stock', valueSAP: '01' },
        { label: 'PRODUCTOS DE EXHIBICION', value: 'exhibicion_stock', valueSAP: '05' },
      ],
    });

    const properties = await getHubspotWarehouseStockPropertiesForTenant(tenantModels, [
      { WarehouseCode: '01', Ordered: 2, Committed: 1, InStock: 7 },
      { WarehouseCode: '05', Ordered: 0, Committed: 3, InStock: 5 },
    ]);

    expect(properties).toEqual({
      distelsa_stock: 8,
      exhibicion_stock: 2,
    });
  });

  it('builds HubSpot stock properties per configured warehouse', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        { label: 'Entrepiso-T1', value: 'A01_stock' },
        { label: 'PVC', value: 'B10_stock' },
        { label: 'No existe', value: 'C99_stock' },
      ],
    });

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

describe('warehouseStock — formula de disponible del tenant', () => {
  const fieldsWareHouseHS = [{ label: 'DISTELSA', value: 'distelsa_stock', valueSAP: '01' }];
  const items = [{ WarehouseCode: '01', Ordered: 2, Committed: 1, InStock: 7 }];

  it('resolveHubspotAvailableFormula lee la clave con getValue y su default, y normaliza', async () => {
    const tenantModels = buildTenantModels({ warehouseAvailableFormula: { add: ['instock'], subtract: ['committed'] } });

    await expect(resolveHubspotAvailableFormula(tenantModels))
      .resolves.toEqual({ add: ['InStock'], subtract: ['Committed'] });
    expect(tenantModels.Configuration.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'warehouseAvailableFormula' },
      { $setOnInsert: { key: 'warehouseAvailableFormula', value: { add: ['InStock', 'Ordered'], subtract: ['Committed'] }, userUpdated: 'admin' } },
      expect.any(Object)
    );
  });

  it('sin documento, el disponible sigue siendo InStock - Committed + Ordered', async () => {
    const properties = await getHubspotWarehouseStockPropertiesForTenant(buildTenantModels({ fieldsWareHouseHS }), items);

    expect(properties).toEqual({ distelsa_stock: 8 });
  });

  it('con la formula de Noelito, el disponible es InStock - Committed', async () => {
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS,
      warehouseAvailableFormula: { add: ['InStock'], subtract: ['Committed'] },
    });

    await expect(getHubspotWarehouseStockPropertiesForTenant(tenantModels, items))
      .resolves.toEqual({ distelsa_stock: 6 });
  });

  it('con formula invalida omite las available, loguea y no tira', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tenantModels = buildTenantModels({
      fieldsWareHouseHS: [
        ...fieldsWareHouseHS,
        { label: 'DISTELSA en stock', value: 'distelsa_instock', valueSAP: '01', metric: 'inStock' },
      ],
      warehouseAvailableFormula: { add: ['InStok'] },
    });

    await expect(getHubspotWarehouseStockPropertiesForTenant(tenantModels, items))
      .resolves.toEqual({ distelsa_instock: 7 });
    expect(consoleError).toHaveBeenCalledWith(
      'Warehouse available formula invalid',
      { raw: { add: ['InStok'] }, reason: 'unknown_field:InStok' }
    );

    consoleError.mockRestore();
  });

  it('buildHubspotWarehouseStockProperties pasa la formula al builder de dominio', () => {
    const fields = normalizeHubspotWarehouseFields(fieldsWareHouseHS);

    expect(buildHubspotWarehouseStockProperties(items, fields, { availableFormula: { add: ['InStock'], subtract: ['Committed'] } }))
      .toEqual({ distelsa_stock: 6 });
    expect(buildHubspotWarehouseStockProperties(items, fields)).toEqual({ distelsa_stock: 8 });
  });
});
