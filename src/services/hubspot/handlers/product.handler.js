import * as hubspotClient from '../../hubspotClient.js';
import tenantConfigurationService from '../../tenantConfiguration.service.js';
import { getWarehouseStockTotalsForTenant } from '../../../utils/warehouseStock.js';

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
  const totals = await getWarehouseStockTotalsForTenant(
    tenantModels,
    item?.rawSapData?.ItemWarehouseInfoCollection
  );
  const priceFields = await resolveHubspotPriceFields(tenantModels);

  item.properties.ordered = totals.ordered;
  item.properties.committed = totals.committed;
  item.properties.instock = totals.instock;
  item.properties.available = totals.instock - totals.committed;

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
