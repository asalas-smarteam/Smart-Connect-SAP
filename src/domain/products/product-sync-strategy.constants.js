export const PRODUCT_SYNC_CONFIG_KEY = 'productSyncStrategy';

export const PRODUCT_SYNC_STRATEGIES = Object.freeze({
  ONE_TO_ONE_PRODUCT: 'oneToOne_Product',
  ONE_TO_MANY_PRODUCT: 'oneToMany_Product',
});

export const DEFAULT_PRODUCT_SYNC_STRATEGY = PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT;

// Marker the oneToOne strategy places on a record when requirePrice is enabled,
// so the product handler keeps the SAP-mapped price instead of zeroing it.
export const KEEP_MAPPED_PRICE_FLAG = 'keepMappedPrice';

export const PRODUCT_SYNC_ON_MISSING_PRICE = Object.freeze({
  SET_ZERO: 'SET_ZERO',
  SKIP_PRODUCT: 'SKIP_PRODUCT',
  THROW_ERROR: 'THROW_ERROR',
});

export const DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE = PRODUCT_SYNC_ON_MISSING_PRICE.SET_ZERO;

export const DEFAULT_PRODUCT_SYNC_HUBSPOT_FIELDS = Object.freeze({
  uniqueItemCode: 'hs_sku',
  baseItemCode: 'sap_base_item_code',
  priceListValue: 'price_list_value',
  price: 'price',
  name: 'name',
});

export const DEFAULT_PRODUCT_SYNC_PATTERNS = Object.freeze({
  uniqueCodePattern: '{itemCode}__PL_{priceListValue}',
  namePattern: '{itemName} - {priceListName}',
});

// De donde sale el precio de un producto en la strategy oneToOne.
// 'mapped' = del campo de cabecera que puso el FieldMapping (comportamiento
// historico: requirePrice.value decide conservar-o-cerar). 'itemPrices' = de la
// fila de ItemPrices cuyo PriceList coincide con la config priceList del tenant.
// El default es 'mapped' a proposito: un tenant sin la llave `source` no cambia
// de comportamiento.
export const PRODUCT_PRICE_SOURCES = Object.freeze({
  MAPPED: 'mapped',
  ITEM_PRICES: 'itemPrices',
});

export const DEFAULT_PRODUCT_PRICE_SOURCE = PRODUCT_PRICE_SOURCES.MAPPED;

export const DEFAULT_PRODUCT_PRICE_FIELD = 'Price';

// Llave bajo la que la strategy adjunta el precio ya resuelto (un numero), para
// que product.handler.js lo escriba en los campos de fieldsPricesHS en vez de
// ponerlos en 0. Mismo contrato que WAREHOUSE_STOCK_KEY y BATCH_EXPIRY_KEY:
// alguien resuelve y adjunta bajo rawSapData, preprocess traduce a propiedades.
export const RESOLVED_PRODUCT_PRICE_KEY = '_resolvedProductPrice';
