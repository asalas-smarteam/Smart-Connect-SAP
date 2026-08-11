// Thin infrastructure wrapper: the actual B1 warehouse-stock logic now lives
// in the domain strategy (src/domain/warehouses/strategies/b1-item-warehouse.strategy.js),
// since it is one of two interchangeable WarehouseStockStrategyPort
// implementations (see WarehouseStockEnrichmentAdapter). Kept here, with the
// same export names, so product.handler.js's B1 fallback path and existing
// tests do not need to change their imports.
import tenantConfigurationService from '../config/tenantConfiguration.service.js';
import {
  buildB1WarehouseStockProperties,
  getAvailableStockForB1Warehouse,
  getWarehouseAvailableStock,
  normalizeB1WarehouseFields,
} from '#domain/warehouses/strategies/b1-item-warehouse.strategy.js';

const DEFAULT_WAREHOUSE_FIELDS = [];
const WAREHOUSE_FIELDS_KEY = 'fieldsWareHouseHS';

export { getWarehouseAvailableStock };

export function normalizeHubspotWarehouseFields(value) {
  return normalizeB1WarehouseFields(value);
}

export async function resolveHubspotWarehouseFields(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    WAREHOUSE_FIELDS_KEY,
    DEFAULT_WAREHOUSE_FIELDS
  );

  return normalizeB1WarehouseFields(value);
}

export function buildHubspotWarehouseStockProperties(
  warehouseItems,
  warehouseFields = DEFAULT_WAREHOUSE_FIELDS
) {
  return buildB1WarehouseStockProperties(warehouseItems, warehouseFields);
}

export async function getHubspotWarehouseStockPropertiesForTenant(tenantModels, warehouseItems) {
  const warehouseFields = await resolveHubspotWarehouseFields(tenantModels);
  return buildB1WarehouseStockProperties(warehouseItems, warehouseFields);
}

export function getAvailableStockForWarehouse(warehouseItems, warehouseCode) {
  return getAvailableStockForB1Warehouse(warehouseItems, warehouseCode);
}
