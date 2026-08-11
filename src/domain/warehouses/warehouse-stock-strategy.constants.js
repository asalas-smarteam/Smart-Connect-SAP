// Which per-tenant Configuration document ({ key: 'warehouseStockStrategy', value: {
// strategy: '...' } }) decides how a product's warehouse stock is resolved into HubSpot
// properties. See src/domain/warehouses/strategies/ for the implementations.
export const WAREHOUSE_STOCK_CONFIG_KEY = 'warehouseStockStrategy';

export const WAREHOUSE_STOCK_STRATEGIES = Object.freeze({
  // Stock embedded in the SAP Business One Item (ItemWarehouseInfoCollection).
  B1_ITEM_WAREHOUSE: 'b1_ItemWarehouse',
  // S/4HANA: stock lives in a separate OData service, keyed by Plant + StorageLocation.
  S4_PLANT_STORAGE_LOCATION: 's4_PlantStorageLocation',
});

// No tenant has to configure anything to keep today's behavior: this is the
// strategy that reproduces what warehouseStock.js already does for B1.
export const DEFAULT_WAREHOUSE_STOCK_STRATEGY = WAREHOUSE_STOCK_STRATEGIES.B1_ITEM_WAREHOUSE;

// Key under which the resolved { propertyName: quantity } map is attached to a
// product's rawSapData by the enrichment adapter, before product.handler.js
// writes it into HubSpot properties. Always set (even to {}) once the
// enricher runs, so "no warehouses configured" is distinguishable from "the
// enricher never ran" (see product.handler.js's hasOwnProperty branch).
export const WAREHOUSE_STOCK_KEY = '_warehouseStock';

// A field's stockType may be this wildcard instead of a code or list of codes,
// meaning "sum every stock type present for this warehouse".
export const STOCK_TYPE_ALL = '*';

// Quantities are summed from string values coming off SAP; rounding avoids
// floating-point noise (12.000000000000002) that would make every product
// look "changed" on every sync even when nothing moved.
export const QUANTITY_DECIMALS = 3;

export default {
  WAREHOUSE_STOCK_CONFIG_KEY,
  WAREHOUSE_STOCK_STRATEGIES,
  DEFAULT_WAREHOUSE_STOCK_STRATEGY,
  WAREHOUSE_STOCK_KEY,
  STOCK_TYPE_ALL,
  QUANTITY_DECIMALS,
};
