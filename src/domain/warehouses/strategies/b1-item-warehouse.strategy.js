// SAP Business One: stock travels embedded in the Item's own
// ItemWarehouseInfoCollection, so this strategy never needs a remote fetch —
// it reads straight off the record already mapped by SyncSapConfigToHubspot.
// This is the historical logic that used to live directly in
// src/infrastructure/hubspot/warehouseStock.js; that module is now a thin
// wrapper re-exporting these functions so no existing import breaks.

const DEFAULT_WAREHOUSE_FIELDS = [];

function resolveWarehouseCodeFromPropertyName(propertyName) {
  if (!propertyName) {
    return null;
  }

  const match = propertyName.match(/^([A-Za-z0-9]+)_stock$/i);
  return match?.[1] ?? '';
}

function resolveWarehouseField(field) {
  const propertyName = field?.value;

  if (!propertyName) {
    return null;
  }

  const rawWarehouseCode = field?.valueSAP || resolveWarehouseCodeFromPropertyName(propertyName);

  if (!rawWarehouseCode) {
    return null;
  }

  return { warehouseCode: String(rawWarehouseCode).toUpperCase(), propertyName };
}

export function getWarehouseAvailableStock(warehouse) {
  const inStock = Number(warehouse?.InStock ?? 0);
  const committed = Number(warehouse?.Committed ?? 0);
  const ordered = Number(warehouse?.Ordered ?? 0);

  return inStock - committed + ordered;
}

export function normalizeB1WarehouseFields(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_WAREHOUSE_FIELDS;
  }

  const seen = new Set();
  const normalizedFields = [];

  value.forEach((field) => {
    const warehouseField = resolveWarehouseField(field);

    if (!warehouseField) {
      return;
    }

    const { warehouseCode, propertyName } = warehouseField;
    const dedupeKey = `${warehouseCode}:${propertyName.toLowerCase()}`;

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    normalizedFields.push({ warehouseCode, propertyName });
  });

  return normalizedFields;
}

// excludedWarehouses was dead in B1 (nothing read it). Here it means: a field
// pointed at an excluded warehouse still gets its property emitted, but
// always as 0 -- the exclusion wins over whatever stock SAP reports.
export function normalizeB1ExcludedWarehouses(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((entry) => String(entry ?? '').trim().toUpperCase())
      .filter(Boolean)
  )];
}

// Bug fix vs. the original inline version: both sides of the WarehouseCode
// comparison are now uppercased (the SAP side used to be compared raw, so a
// lowercase WarehouseCode from SAP silently never matched), and the missing
// optional-chaining on field.warehouseCode no longer throws when a caller
// passes a field without one.
export function buildB1WarehouseStockProperties(
  warehouseItems,
  warehouseFields = DEFAULT_WAREHOUSE_FIELDS,
  exclusions = []
) {
  const excludedSet = new Set(exclusions);
  const warehousesByCode = new Map(
    (Array.isArray(warehouseItems) ? warehouseItems : [])
      .map((warehouse) => [String(warehouse?.WarehouseCode ?? '').toUpperCase(), warehouse])
      .filter(([warehouseCode]) => warehouseCode)
  );

  return (Array.isArray(warehouseFields) ? warehouseFields : []).reduce((acc, field) => {
    const propertyName = field?.propertyName;
    const warehouseCode = field?.warehouseCode ? String(field.warehouseCode).toUpperCase() : null;

    if (!propertyName || !warehouseCode) {
      return acc;
    }

    if (excludedSet.has(warehouseCode)) {
      acc[propertyName] = 0;
      return acc;
    }

    acc[propertyName] = getWarehouseAvailableStock(warehousesByCode.get(warehouseCode));
    return acc;
  }, {});
}

export function getAvailableStockForB1Warehouse(warehouseItems, warehouseCode) {
  if (!warehouseCode) {
    return 0;
  }

  const normalized = String(warehouseCode).toUpperCase();
  const warehouse = (Array.isArray(warehouseItems) ? warehouseItems : []).find(
    (item) => String(item?.WarehouseCode ?? '').toUpperCase() === normalized
  );

  return getWarehouseAvailableStock(warehouse);
}

export class B1ItemWarehouseStrategy {
  normalizeFields(rawValue) {
    return normalizeB1WarehouseFields(rawValue);
  }

  normalizeExclusions(rawValue) {
    return normalizeB1ExcludedWarehouses(rawValue);
  }

  requiresRemoteFetch() {
    return false;
  }

  // Nothing to fetch remotely: stock is already embedded in rawSapData.
  buildQueryTargets() {
    return [];
  }

  // Unused when requiresRemoteFetch() is false; kept so the strategy still
  // satisfies WarehouseStockStrategyPort.
  buildIndex() {
    return new Map();
  }

  buildProperties({ record, fields, exclusions = [] }) {
    return buildB1WarehouseStockProperties(
      record?.rawSapData?.ItemWarehouseInfoCollection,
      fields,
      exclusions
    );
  }
}

export default B1ItemWarehouseStrategy;
