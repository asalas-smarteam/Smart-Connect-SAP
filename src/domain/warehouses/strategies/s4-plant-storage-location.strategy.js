// SAP S/4HANA: stock is not embedded in the product. It lives in a separate
// OData service (API_MATERIAL_STOCK_SRV), keyed by Plant + StorageLocation --
// a "warehouse" here is that pair, e.g. valueSAP "MQGT/0008". The same
// StorageLocation code repeats across different plants (verified live:
// "0008" exists under both MQGT and MQDO), so Plant is never optional.
import {
  QUANTITY_DECIMALS,
  STOCK_TYPE_ALL,
} from '../warehouse-stock-strategy.constants.js';

// '01' = Unrestricted-use stock (Libre utilización) -- the closest S/4
// equivalent to B1's "available to sell". A field with no stockType gets
// this alone, not every type, so a plain configuration never overstates what
// can actually be shipped.
const DEFAULT_STOCK_TYPES = ['01'];

// "MQGT/0008" -> { plant: 'MQGT', storageLocation: '0008' }
// "DPDO/*" or "DPDO" -> { plant: 'DPDO', storageLocation: null }  (whole plant)
// "" | null | "A/B/C" -> null (invalid)
export function parseS4WarehouseCode(valueSAP) {
  const raw = String(valueSAP ?? '').trim();

  if (!raw) {
    return null;
  }

  const segments = raw.split('/');

  if (segments.length > 2) {
    return null;
  }

  const plant = String(segments[0] ?? '').trim().toUpperCase();

  if (!plant) {
    return null;
  }

  const locationPart = segments.length === 2 ? String(segments[1] ?? '').trim() : '';

  if (!locationPart || locationPart === STOCK_TYPE_ALL) {
    return { plant, storageLocation: null };
  }

  return { plant, storageLocation: locationPart };
}

// undefined -> ['01']; '02' -> ['02']; ['01','02'] -> ['01','02']; '*' -> '*'
export function normalizeS4StockTypes(stockType) {
  if (stockType === STOCK_TYPE_ALL) {
    return STOCK_TYPE_ALL;
  }

  if (Array.isArray(stockType)) {
    const codes = [...new Set(
      stockType.map((code) => String(code ?? '').trim()).filter(Boolean)
    )];
    return codes.length > 0 ? codes : [...DEFAULT_STOCK_TYPES];
  }

  const single = String(stockType ?? '').trim();

  if (!single) {
    return [...DEFAULT_STOCK_TYPES];
  }

  return single === STOCK_TYPE_ALL ? STOCK_TYPE_ALL : [single];
}

// [{label, value, valueSAP, stockType?}] -> [{propertyName, plant, storageLocation, stockTypes}]
// One entry = one HubSpot property; two entries with the same `value` is a
// config mistake (not an implicit sum), so the first one wins.
export function normalizeS4WarehouseFields(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const fields = [];

  for (const entry of value) {
    const propertyName = entry?.value;

    if (!propertyName) {
      continue;
    }

    const dedupeKey = String(propertyName).toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    const parsed = parseS4WarehouseCode(entry?.valueSAP);

    if (!parsed) {
      continue;
    }

    seen.add(dedupeKey);
    fields.push({
      propertyName,
      plant: parsed.plant,
      storageLocation: parsed.storageLocation,
      stockTypes: normalizeS4StockTypes(entry?.stockType),
    });
  }

  return fields;
}

// Reuses the same "Plant[/StorageLocation|*]" grammar as fieldsWareHouseHS,
// plus bare codes (legacy B1-shaped exclusion lists), which parse as "whole
// plant" -- harmless for S/4 since no S/4 plant is ever literally named that.
export function normalizeS4ExcludedWarehouses(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => parseS4WarehouseCode(entry)).filter(Boolean);
}

function isS4WarehouseExcluded(exclusions, { plant, storageLocation }) {
  return (Array.isArray(exclusions) ? exclusions : []).some(
    (exclusion) => exclusion.plant === plant
      && (exclusion.storageLocation === null || exclusion.storageLocation === storageLocation)
  );
}

// Groups configured fields by Plant so the resolver issues exactly one
// fetchAll per Plant (never per product, never per field). A wildcard
// storageLocation for a Plant makes that Plant's target `storageLocations:
// null` (fetch the whole Plant), which wins over any explicit list for the
// same Plant.
export function buildS4StockQueryTargets(fields) {
  const byPlant = new Map();

  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field?.plant) {
      continue;
    }

    if (!byPlant.has(field.plant)) {
      byPlant.set(field.plant, { wildcard: false, locations: new Set() });
    }

    const target = byPlant.get(field.plant);

    if (field.storageLocation === null) {
      target.wildcard = true;
    } else {
      target.locations.add(field.storageLocation);
    }
  }

  return [...byPlant.entries()].map(([plant, target]) => ({
    plant,
    storageLocations: target.wildcard ? null : [...target.locations],
  }));
}

function roundQuantity(value) {
  const factor = 10 ** QUANTITY_DECIMALS;
  return Math.round((Number(value) || 0) * factor) / factor;
}

// Raw A_MatlStkInAcctMod rows -> Map<Material, [{plant, storageLocation, stockType, quantity}]>.
// Discards rows with no material, with a non-blank InventorySpecialStockType
// (consignment/subcontracting -- not the tenant's own stock), and rows under
// an excluded warehouse. Sums duplicates that only differ by Batch/Supplier/
// Customer (fields deliberately left out of the $select) into one entry per
// (Plant, StorageLocation, InventoryStockType).
export function buildS4StockIndex(rows, { exclusions = [] } = {}) {
  const byMaterial = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const material = String(row?.Material ?? '').trim();

    if (!material) {
      continue;
    }

    const specialStockType = String(row?.InventorySpecialStockType ?? '').trim();

    if (specialStockType) {
      continue;
    }

    const plant = String(row?.Plant ?? '').trim().toUpperCase();

    if (!plant) {
      continue;
    }

    const storageLocation = String(row?.StorageLocation ?? '').trim();

    if (isS4WarehouseExcluded(exclusions, { plant, storageLocation })) {
      continue;
    }

    const stockType = String(row?.InventoryStockType ?? '').trim();
    const quantity = Number(row?.MatlWrhsStkQtyInMatlBaseUnit ?? 0) || 0;

    if (!byMaterial.has(material)) {
      byMaterial.set(material, new Map());
    }

    const entries = byMaterial.get(material);
    const entryKey = `${plant}|${storageLocation}|${stockType}`;
    const existing = entries.get(entryKey);

    if (existing) {
      existing.quantity += quantity;
    } else {
      entries.set(entryKey, { plant, storageLocation, stockType, quantity });
    }
  }

  const index = new Map();
  for (const [material, entries] of byMaterial) {
    index.set(material, [...entries.values()]);
  }

  return index;
}

function rowMatchesField(row, field) {
  if (row.plant !== field.plant) {
    return false;
  }

  if (field.storageLocation !== null && row.storageLocation !== field.storageLocation) {
    return false;
  }

  return field.stockTypes === STOCK_TYPE_ALL || field.stockTypes.includes(row.stockType);
}

// -> { [propertyName]: number }. Always emits every configured field (0 when
// there is no matching row), the same contract as the B1 strategy, so
// product.handler.js never has to know which strategy produced the object.
export function buildS4StockProperties({ record, index, fields }) {
  const material = String(record?.rawSapData?.Product ?? '').trim();
  const rows = (index instanceof Map ? index.get(material) : null) ?? [];

  return (Array.isArray(fields) ? fields : []).reduce((acc, field) => {
    if (!field?.propertyName) {
      return acc;
    }

    const total = rows
      .filter((row) => rowMatchesField(row, field))
      .reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);

    acc[field.propertyName] = roundQuantity(total);
    return acc;
  }, {});
}

export class S4PlantStorageLocationStrategy {
  normalizeFields(rawValue) {
    return normalizeS4WarehouseFields(rawValue);
  }

  normalizeExclusions(rawValue) {
    return normalizeS4ExcludedWarehouses(rawValue);
  }

  requiresRemoteFetch() {
    return true;
  }

  buildQueryTargets(fields) {
    return buildS4StockQueryTargets(fields);
  }

  buildIndex(rows, { exclusions = [] } = {}) {
    return buildS4StockIndex(rows, { exclusions });
  }

  buildProperties({ record, index, fields }) {
    return buildS4StockProperties({ record, index, fields });
  }
}

export default S4PlantStorageLocationStrategy;
