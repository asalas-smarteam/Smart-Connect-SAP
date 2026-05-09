export const PRODUCT_SYNC_CONFIG_KEY = 'productSyncStrategy';

export const PRODUCT_SYNC_STRATEGIES = Object.freeze({
  ONE_TO_ONE_PRODUCT: 'oneToOne_Product',
  ONE_TO_MANY_PRODUCT: 'oneToMany_Product',
});

export const DEFAULT_PRODUCT_SYNC_STRATEGY = PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT;

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
