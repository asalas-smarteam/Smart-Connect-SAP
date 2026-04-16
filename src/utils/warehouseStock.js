import tenantConfigurationService from '../services/tenantConfiguration.service.js';

const DEFAULT_WAREHOUSE_FIELDS = [];
const WAREHOUSE_FIELDS_KEY = 'fieldsWareHouseHS';

function resolveWarehouseCodeFromPropertyName(propertyName) {
  const normalizedPropertyName = propertyName;

  if (!normalizedPropertyName) {
    return null;
  }

  const match = normalizedPropertyName.match(/^([A-Za-z0-9]+)_stock$/i);
  return match?.[1] ?? '';
}

export function getWarehouseAvailableStock(warehouse) {
  return warehouse?.InStock
    - warehouse?.Committed
    + warehouse?.Ordered;
}

export function normalizeHubspotWarehouseFields(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_WAREHOUSE_FIELDS;
  }

  const seen = new Set();
  const normalizedFields = [];

  value.forEach((field) => {
    const propertyName = field?.value;
    const warehouseCode = resolveWarehouseCodeFromPropertyName(propertyName);

    if (!propertyName || !warehouseCode) {
      return;
    }

    const dedupeKey = `${warehouseCode}:${propertyName.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    normalizedFields.push({
      warehouseCode,
      propertyName,
    });
  });

  return normalizedFields;
}

export async function resolveHubspotWarehouseFields(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    WAREHOUSE_FIELDS_KEY,
    DEFAULT_WAREHOUSE_FIELDS
  );

  return normalizeHubspotWarehouseFields(value);
}

export function buildHubspotWarehouseStockProperties(
  warehouseItems,
  warehouseFields = DEFAULT_WAREHOUSE_FIELDS
) {
  const warehousesByCode = new Map(
    (Array.isArray(warehouseItems) ? warehouseItems : [])
      .map((warehouse) => [warehouse?.WarehouseCode, warehouse])
      .filter(([warehouseCode]) => warehouseCode)
  );

  return (Array.isArray(warehouseFields) ? warehouseFields : []).reduce((acc, field) => {
    const propertyName = field?.propertyName;
    const warehouseCode = field?.warehouseCode.toUpperCase();

    if (!propertyName || !warehouseCode) {
      return acc;
    }

    acc[propertyName] = getWarehouseAvailableStock(warehousesByCode.get(warehouseCode));
    return acc;
  }, {});
}

export async function getHubspotWarehouseStockPropertiesForTenant(tenantModels, warehouseItems) {
  const warehouseFields = await resolveHubspotWarehouseFields(tenantModels);
  return buildHubspotWarehouseStockProperties(warehouseItems, warehouseFields);
}

export function getAvailableStockForWarehouse(warehouseItems, warehouseCode) {
  const normalizedWarehouseCode = warehouseCode;
  if (!normalizedWarehouseCode) {
    return 0;
  }

  const warehouse = (Array.isArray(warehouseItems) ? warehouseItems : []).find(
    (item) => item?.WarehouseCode === normalizedWarehouseCode
  );

  return getWarehouseAvailableStock(warehouse);
}
