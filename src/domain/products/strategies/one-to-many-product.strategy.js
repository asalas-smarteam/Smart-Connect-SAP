import {
  DEFAULT_PRODUCT_SYNC_HUBSPOT_FIELDS,
  DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE,
  DEFAULT_PRODUCT_SYNC_PATTERNS,
  PRODUCT_SYNC_ON_MISSING_PRICE,
  PRODUCT_SYNC_STRATEGIES,
} from '../product-sync-strategy.constants.js';

const UPSERT_PRODUCT_SKU_FIELD = 'hs_sku';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizePriceList(priceList) {
  const name = toNonEmptyString(priceList?.name ?? priceList?.label);
  const value = toNonEmptyString(priceList?.value ?? priceList?.PriceList);

  if (!name || !value) {
    return null;
  }

  return { name, value };
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

function resolveOnMissingPrice(strategyConfig = {}) {
  const normalized = toNonEmptyString(strategyConfig.onMissingPrice)
    || DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE;

  return Object.values(PRODUCT_SYNC_ON_MISSING_PRICE).includes(normalized)
    ? normalized
    : DEFAULT_PRODUCT_SYNC_ON_MISSING_PRICE;
}

export class OneToManyProductStrategy {
  constructor({ hubspotSyncTarget, sapPriceProvider, logger = console }) {
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.sapPriceProvider = sapPriceProvider;
    this.logger = logger;
  }

  async execute({
    mappedRecords,
    config,
    objectType,
    tenantModels,
    credentials,
    tenantId,
    tenantKey,
    strategyConfig = {},
  }) {
    const products = Array.isArray(mappedRecords) ? mappedRecords : [];
    const priceLists = normalizePriceLists(strategyConfig.priceLists);

    if (priceLists.length === 0) {
      throw new Error('productSyncStrategy.priceLists must be a non-empty array for oneToMany_Product');
    }

    this.logger.info?.({
      msg: 'Starting product sync strategy',
      tenantId,
      tenantKey,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
      totalProducts: products.length,
      priceLists,
    });

    const expandedRecords = [];
    let failed = 0;

    for (const product of products) {
      const itemCode = resolveSapItemCode(product);

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
        config,
        tenantModels,
        credentials,
        tenantId,
        tenantKey,
        strategyConfig,
        priceLists,
      });

      expandedRecords.push(...productRecords.records);
      failed += productRecords.failed;
    }

    if (expandedRecords.length === 0) {
      return { sent: 0, failed, recordsProcessed: failed };
    }

    try {
      const result = await this.hubspotSyncTarget.send({
        mappedRecords: expandedRecords,
        config,
        objectType,
        tenantModels,
        credentials,
      });

      return {
        sent: result?.sent ?? 0,
        failed: failed + (result?.failed ?? 0),
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
        recordsProcessed: expandedRecords.length + failed,
      };
    }
  }

  async buildRecordsForProduct({
    product,
    itemCode,
    config,
    tenantModels,
    credentials,
    tenantId,
    tenantKey,
    strategyConfig,
    priceLists,
  }) {
    const onMissingPrice = resolveOnMissingPrice(strategyConfig);
    const itemName = resolveSapItemName(product, itemCode);
    const pricesByList = await this.sapPriceProvider.getItemPricesByPriceLists({
      clientConfig: config,
      tenantModels,
      credentials,
      itemCode,
      priceLists,
      tenantKey,
    });
    const records = [];
    let failed = 0;

    for (const priceList of priceLists) {
      const selectedPrice = pricesByList.get(priceList.value);

      if (!selectedPrice) {
        const missingResult = this.handleMissingPrice({
          itemCode,
          priceList,
          onMissingPrice,
          tenantId,
        });

        if (missingResult.skip) {
          failed += 1;
          continue;
        }

        records.push(this.buildRecord({
          product,
          itemCode,
          itemName,
          priceList,
          priceData: { Price: 0, Currency: null, PriceList: priceList.value },
          strategyConfig,
          tenantId,
        }));
        continue;
      }

      records.push(this.buildRecord({
        product,
        itemCode,
        itemName,
        priceList,
        priceData: selectedPrice,
        strategyConfig,
        tenantId,
      }));
    }

    return { records, failed };
  }

  handleMissingPrice({ itemCode, priceList, onMissingPrice, tenantId }) {
    this.logger.warn?.({
      msg: 'SAP price list not found for product',
      tenantId,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_MANY_PRODUCT,
      itemCode,
      priceListName: priceList.name,
      priceListValue: priceList.value,
      onMissingPrice,
    });

    if (onMissingPrice === PRODUCT_SYNC_ON_MISSING_PRICE.THROW_ERROR) {
      throw new Error(`Price list ${priceList.value} not found for item ${itemCode}`);
    }

    return { skip: onMissingPrice === PRODUCT_SYNC_ON_MISSING_PRICE.SKIP_PRODUCT };
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
      [fields.priceListName]: priceList.name,
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
