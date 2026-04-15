import tenantConfigurationService from '../services/tenantConfiguration.service.js';

const DEFAULT_EXCLUDED_WAREHOUSES = [];
const EXCLUDED_WAREHOUSES_KEY = 'excludedWarehouses';

function normalizeWarehouseCode(code) {
  return String(code || '').trim().toUpperCase();
}

export async function resolveExcludedWarehouses(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    EXCLUDED_WAREHOUSES_KEY,
    DEFAULT_EXCLUDED_WAREHOUSES
  );

  return Array.isArray(value) ? value : DEFAULT_EXCLUDED_WAREHOUSES;
}

export function getWarehouseStockTotals(warehouseItems, excludedWarehouses = DEFAULT_EXCLUDED_WAREHOUSES) {
  const excludedCodes = new Set((Array.isArray(excludedWarehouses) ? excludedWarehouses : [])
    .map((code) => normalizeWarehouseCode(code))
    .filter(Boolean));

  return (Array.isArray(warehouseItems) ? warehouseItems : []).reduce(
    (acc, warehouse) => {
      const warehouseCode = normalizeWarehouseCode(warehouse?.WarehouseCode);
      if (excludedCodes.has(warehouseCode)) {
        return acc;
      }

      acc.ordered += Number(warehouse?.Ordered || 0);
      acc.committed += Number(warehouse?.Committed || 0);
      acc.instock += Number(warehouse?.InStock || 0);
      return acc;
    },
    { ordered: 0, committed: 0, instock: 0 }
  );
}

export async function getWarehouseStockTotalsForTenant(tenantModels, warehouseItems) {
  const excludedWarehouses = await resolveExcludedWarehouses(tenantModels);
  return getWarehouseStockTotals(warehouseItems, excludedWarehouses);
}
