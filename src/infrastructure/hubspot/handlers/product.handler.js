import * as hubspotClient from '../hubspotClient.js';
import tenantConfigurationService from '#infrastructure/config/tenantConfiguration.service.js';
import { KEEP_MAPPED_PRICE_FLAG } from '#domain/products/product-sync-strategy.constants.js';
import { getHubspotWarehouseStockPropertiesForTenant } from '../warehouseStock.js';

const DEFAULT_PRICE_FIELDS = ['hs_price_usd'];
const PRICE_FIELDS_CONFIG_KEY = 'fieldsPricesHS';

function normalizeHubspotPriceFields(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_PRICE_FIELDS;
  }

  const normalizedFields = value
    .map((field) => String(field ?? '').trim())
    .filter(Boolean);

  return normalizedFields.length > 0
    ? [...new Set(normalizedFields)]
    : DEFAULT_PRICE_FIELDS;
}

export async function resolveHubspotPriceFields(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    PRICE_FIELDS_CONFIG_KEY,
    DEFAULT_PRICE_FIELDS
  );

  return normalizeHubspotPriceFields(value);
}

export async function preprocess({ item, tenantModels }) {
  const warehouseStockProperties = await getHubspotWarehouseStockPropertiesForTenant(
    tenantModels,
    item?.rawSapData?.ItemWarehouseInfoCollection
  );
  const priceFields = await resolveHubspotPriceFields(tenantModels);
  item.properties = item.properties || {};

  Object.assign(item.properties, warehouseStockProperties);

  const resolvedDiscount = item?.rawSapData?._resolvedDiscount;
  const discountHsProperty = item?.rawSapData?._discountHsProperty;
  if (resolvedDiscount !== null && resolvedDiscount !== undefined && discountHsProperty) {
    item.properties[discountHsProperty] = resolvedDiscount;
  }

  if (item?.rawSapData?.selectedPrice || item?.rawSapData?.[KEEP_MAPPED_PRICE_FLAG]) {
    return;
  }

  priceFields.forEach((field) => {
    item.properties[field] = 0.0;
  });
}

export async function find({ token, item }) {
  const sku = item?.properties?.hs_sku;

  if (!sku) {
    return null;
  }

  return hubspotClient.findProductBySKU(token, sku);
}

export async function create({ token, item }) {
  return hubspotClient.createProduct(token, item);
}

export async function update({ token, id, item }) {
  return hubspotClient.updateProduct(token, id, item);
}

export default {
  find,
  create,
  update,
  preprocess,
};
