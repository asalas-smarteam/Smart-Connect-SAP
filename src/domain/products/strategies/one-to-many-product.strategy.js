import {
  DEFAULT_PRODUCT_SYNC_HUBSPOT_FIELDS,
  DEFAULT_PRODUCT_SYNC_PATTERNS,
  PRODUCT_SYNC_STRATEGIES,
} from '../product-sync-strategy.constants.js';

const UPSERT_PRODUCT_SKU_FIELD = 'hs_sku';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizePriceList(priceList) {
  const value = toNonEmptyString(priceList?.value ?? priceList?.PriceList);
  const name = toNonEmptyString(priceList?.name ?? priceList?.label ?? priceList?.PriceListName)
    || value;

  if (!value) {
    return null;
  }

  return { name, value, priceData: priceList };
}

function normalizePriceLists(value) {
  return Array.isArray(value)
    ? value.map(normalizePriceList).filter(Boolean)
    : [];
}

function resolveNumber(value, fallback = 0) {
  const normalized = Number(String(value ?? '').trim());
  return Number.isFinite(normalized) ? normalized : fallback;
}

function applyPattern(pattern, replacements) {
  return String(pattern ?? '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

function resolveSapItemCode(item) {
  return toNonEmptyString(item?.rawSapData?.ItemCode)
    || toNonEmptyString(item?.properties?.hs_sku)
    || toNonEmptyString(item?.properties?.idsap);
}

function resolveSapItemName(item, itemCode) {
  return toNonEmptyString(item?.rawSapData?.ItemName)
    || toNonEmptyString(item?.properties?.name)
    || itemCode;
}

function mergeHubspotFields(strategyConfig = {}) {
  return {
    ...DEFAULT_PRODUCT_SYNC_HUBSPOT_FIELDS,
    ...(strategyConfig?.hubspotFields ?? {}),
  };
}

export class OneToManyProductStrategy {
  constructor({ hubspotSyncTarget, logger = console }) {
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.logger = logger;
  }

  async execute({
    mappedRecords,
    config,
    objectType,
    tenantContext,
    credentials,
    tenantId,
    tenantKey,
    strategyConfig = {},
  }) {
    const products = Array.isArray(mappedRecords) ? mappedRecords : [];
    const configuredPriceListNames = new Map(
      normalizePriceLists(strategyConfig.priceLists)
        .map((priceList) => [priceList.value, priceList.name])
    );

    this.logger.info?.({
      msg: 'Starting product sync strategy',
      tenantId,
      tenantKey,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
      totalProducts: products.length,
    });

    const expandedRecords = [];
    let failed = 0;

    for (const product of products) {
      const itemCode = resolveSapItemCode(product);
      const priceLists = normalizePriceLists(product?.rawSapData?.ItemPrices)
        .map((priceList) => ({
          ...priceList,
          name: configuredPriceListNames.get(priceList.value) || priceList.name,
        }));

      if (!itemCode) {
        failed += priceLists.length;
        this.logger.warn?.({
          msg: 'Skipping SAP product without ItemCode',
          tenantId,
          strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
        });
        continue;
      }

      const productRecords = await this.buildRecordsForProduct({
        product,
        itemCode,
        tenantId,
        strategyConfig,
        priceLists,
      });

      expandedRecords.push(...productRecords.records);
      failed += productRecords.failed;
    }

    if (expandedRecords.length === 0) {
      return { sent: 0, failed, created: 0, updated: 0, recordsProcessed: failed };
    }

    try {
      const result = await this.hubspotSyncTarget.send({
        mappedRecords: expandedRecords,
        config,
        objectType,
        tenantContext,
        credentials,
      });

      return {
        sent: result?.sent ?? 0,
        failed: failed + (result?.failed ?? 0),
        created: result?.created ?? 0,
        updated: result?.updated ?? Math.max((result?.sent ?? 0) - (result?.created ?? 0), 0),
        recordsProcessed: expandedRecords.length + failed,
      };
    } catch (error) {
      this.logger.error?.({
        msg: 'Product one-to-many HubSpot sync failed',
        tenantId,
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
        expandedProducts: expandedRecords.length,
        error: error.message,
      });

      return {
        sent: 0,
        failed: failed + expandedRecords.length,
        created: 0,
        updated: 0,
        recordsProcessed: expandedRecords.length + failed,
      };
    }
  }

  async buildRecordsForProduct({
    product,
    itemCode,
    tenantId,
    strategyConfig,
    priceLists,
  }) {
    const itemName = resolveSapItemName(product, itemCode);
    const records = [];

    for (const priceList of priceLists) {
      records.push(this.buildRecord({
        product,
        itemCode,
        itemName,
        priceList,
        priceData: priceList.priceData,
        strategyConfig,
        tenantId,
      }));
    }

    return { records, failed: 0 };
  }

  buildRecord({
    product,
    itemCode,
    itemName,
    priceList,
    priceData,
    strategyConfig,
    tenantId,
  }) {
    const fields = mergeHubspotFields(strategyConfig);
    const uniqueCodePattern = strategyConfig.uniqueCodePattern
      || DEFAULT_PRODUCT_SYNC_PATTERNS.uniqueCodePattern;
    const namePattern = strategyConfig.namePattern
      || DEFAULT_PRODUCT_SYNC_PATTERNS.namePattern;
    const uniqueItemCode = applyPattern(uniqueCodePattern, {
      itemCode,
      itemName,
      priceListName: priceList.name,
      priceListValue: priceList.value,
    });
    const name = applyPattern(namePattern, {
      itemCode,
      itemName,
      priceListName: priceList.name,
      priceListValue: priceList.value,
    });
    const price = resolveNumber(priceData?.Price, 0);
    const properties = {
      ...(product?.properties ?? {}),
      [UPSERT_PRODUCT_SKU_FIELD]: uniqueItemCode,
      [fields.baseItemCode]: itemCode,
      [fields.priceListValue]: priceList.value,
      [fields.price]: price,
      [fields.name]: name,
    };

    if (fields.uniqueItemCode !== UPSERT_PRODUCT_SKU_FIELD) {
      properties[fields.uniqueItemCode] = uniqueItemCode;
    }

    this.logger.info?.({
      msg: 'Prepared product by price list',
      tenantId,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
      itemCode,
      priceListName: priceList.name,
      priceListValue: priceList.value,
      resolvedPrice: price,
      uniqueItemCode,
      status: 'prepared',
    });

    return {
      ...product,
      properties,
      rawSapData: {
        ...(product?.rawSapData ?? {}),
        selectedPrice: priceData,
      },
    };
  }
}

export default OneToManyProductStrategy;
