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
  normalizeB1AvailableFormula,
  normalizeB1WarehouseFields,
} from '#domain/warehouses/strategies/b1-item-warehouse.strategy.js';
import {
  DEFAULT_B1_AVAILABLE_FORMULA,
  WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
} from '#domain/warehouses/warehouse-stock-strategy.constants.js';

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

// getValue crea el documento con el default la primera vez que falta (igual
// que con fieldsWareHouseHS), asi que un tenant "aparece" con la clave tras el
// primer webhook de precios aunque nadie la haya insertado. Este camino no
// tiene syncLogId ni repositorio de avisos: una formula invalida queda en el
// log y omite las `available`; el SyncWarning lo escribe el sync de productos
// (WarehouseStockEnrichmentAdapter) sobre la misma config.
export async function resolveHubspotAvailableFormula(tenantModels) {
  // Copia, no la referencia congelada: getValue la manda tal cual a
  // $setOnInsert, y tenantProvisioning.js ya la copia por la misma razon.
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY,
    { add: [...DEFAULT_B1_AVAILABLE_FORMULA.add], subtract: [...DEFAULT_B1_AVAILABLE_FORMULA.subtract] }
  );

  return normalizeB1AvailableFormula(value, {
    onInvalid: (entry) => console.error('Warehouse available formula invalid', entry),
  });
}

export function buildHubspotWarehouseStockProperties(
  warehouseItems,
  warehouseFields = DEFAULT_WAREHOUSE_FIELDS,
  options = {}
) {
  return buildB1WarehouseStockProperties(warehouseItems, warehouseFields, [], options);
}

export async function getHubspotWarehouseStockPropertiesForTenant(tenantModels, warehouseItems) {
  const [warehouseFields, availableFormula] = await Promise.all([
    resolveHubspotWarehouseFields(tenantModels),
    resolveHubspotAvailableFormula(tenantModels),
  ]);

  return buildB1WarehouseStockProperties(warehouseItems, warehouseFields, [], { availableFormula });
}

export function getAvailableStockForWarehouse(warehouseItems, warehouseCode) {
  return getAvailableStockForB1Warehouse(warehouseItems, warehouseCode);
}
