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

// Que numero de una bodega de B1 va a la propiedad de HubSpot. Es el eje
// equivalente a stockType del lado S/4: uno por field, no por tenant, para que
// un tenant pueda pedir tres columnas de una bodega y una sola de otra.
export const B1_STOCK_METRICS = Object.freeze({
  // InStock - Committed + Ordered. El comportamiento historico y el default:
  // ninguna config existente declara metric, y ninguna debe cambiar.
  AVAILABLE: 'available',
  IN_STOCK: 'inStock',
  COMMITTED: 'committed',
  ORDERED: 'ordered',
});

export const DEFAULT_B1_STOCK_METRIC = B1_STOCK_METRICS.AVAILABLE;

// code del documento de SyncWarnings que se escribe cuando una entrada de
// fieldsWareHouseHS declara una metric que no existe. La entrada se descarta:
// caer de vuelta a available escribiria un numero plausible pero equivocado en
// una columna de inventario, y eso nadie lo detecta mirando.
export const WAREHOUSE_METRIC_INVALID_WARNING = 'warehouse_metric_invalid';

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
  B1_STOCK_METRICS,
  DEFAULT_B1_STOCK_METRIC,
  WAREHOUSE_METRIC_INVALID_WARNING,
  QUANTITY_DECIMALS,
};
