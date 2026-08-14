import * as hubspotClient from '../hubspotClient.js';
import tenantConfigurationService from '#infrastructure/config/tenantConfiguration.service.js';
import { KEEP_MAPPED_PRICE_FLAG } from '#domain/products/product-sync-strategy.constants.js';
import { WAREHOUSE_STOCK_KEY } from '#domain/warehouses/warehouse-stock-strategy.constants.js';
import { BATCH_EXPIRY_KEY } from '#domain/batches/batch-expiry.constants.js';
import { buildExclusiveDiscountProperties } from '#domain/products/discount-properties.service.js';
import {
  buildHubspotWarehouseStockProperties,
  getHubspotWarehouseStockPropertiesForTenant,
  resolveHubspotWarehouseFields,
} from '../warehouseStock.js';

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

// Resolves the tenant configuration preprocess() depends on. Callers processing many
// items should call this once per run and pass the result as `preprocessContext` to
// every preprocess() call — otherwise each item pays two Configuration reads.
export async function buildPreprocessContext({ tenantModels }) {
  const [warehouseFields, priceFields] = await Promise.all([
    resolveHubspotWarehouseFields(tenantModels),
    resolveHubspotPriceFields(tenantModels),
  ]);

  return { warehouseFields, priceFields };
}

export async function preprocess({ item, tenantModels, preprocessContext }) {
  const rawSapData = item?.rawSapData ?? {};
  // WarehouseStockEnrichmentAdapter (SyncSapConfigToHubspot) already resolves
  // this via whichever WarehouseStockStrategy the tenant is configured for
  // (B1 embedded, S/4 Plant+StorageLocation, ...) and always sets the key --
  // even to {} when nothing is configured. Checking hasOwnProperty instead of
  // truthiness is what keeps an S/4 sync from falling through to the B1
  // branch below and zeroing every warehouse property: rawSapData has no
  // ItemWarehouseInfoCollection on S/4, so that branch would otherwise read
  // `undefined` and write 0 into every configured field.
  //
  // The B1 branch stays as a fallback for tenants with no
  // warehouseStockStrategy Configuration yet, and for tests that call
  // preprocess() directly without going through the full sync pipeline.
  const warehouseStockProperties = Object.prototype.hasOwnProperty.call(rawSapData, WAREHOUSE_STOCK_KEY)
    ? rawSapData[WAREHOUSE_STOCK_KEY]
    : preprocessContext?.warehouseFields
      ? buildHubspotWarehouseStockProperties(
        rawSapData.ItemWarehouseInfoCollection,
        preprocessContext.warehouseFields
      )
      : await getHubspotWarehouseStockPropertiesForTenant(
        tenantModels,
        rawSapData.ItemWarehouseInfoCollection
      );
  const priceFields = preprocessContext?.priceFields
    ?? await resolveHubspotPriceFields(tenantModels);
  item.properties = item.properties || {};

  Object.assign(item.properties, warehouseStockProperties);

  // A diferencia del stock por bodega, esta clave puede NO estar: el enricher la
  // omite cuando el tenant no maneja lotes o cuando la lectura de SAP fallo. En
  // ese caso no se toca nada y HubSpot conserva lo de la corrida anterior, en
  // vez de quedar con las propiedades en blanco por un timeout de red.
  if (Object.prototype.hasOwnProperty.call(rawSapData, BATCH_EXPIRY_KEY)) {
    Object.assign(item.properties, rawSapData[BATCH_EXPIRY_KEY]);
  }

  const resolvedDiscount = item?.rawSapData?._resolvedDiscount;
  const discountHsProperty = item?.rawSapData?._discountHsProperty;
  if (resolvedDiscount !== null && resolvedDiscount !== undefined && discountHsProperty) {
    // Blanks the mutually exclusive discount property so a value left over from
    // an earlier sync cannot make HubSpot reject the record.
    Object.assign(
      item.properties,
      buildExclusiveDiscountProperties(discountHsProperty, resolvedDiscount)
    );
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
  buildPreprocessContext,
};
