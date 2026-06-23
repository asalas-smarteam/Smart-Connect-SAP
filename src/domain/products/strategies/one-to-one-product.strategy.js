import {
  KEEP_MAPPED_PRICE_FLAG,
  PRODUCT_SYNC_STRATEGIES,
} from '../product-sync-strategy.constants.js';

function markRecordToKeepMappedPrice(record) {
  return {
    ...record,
    rawSapData: {
      ...(record?.rawSapData ?? {}),
      [KEEP_MAPPED_PRICE_FLAG]: true,
    },
  };
}

function removeMappedField(record, field) {
  const properties = { ...(record?.properties ?? {}) };
  delete properties[field];
  return { ...record, properties };
}

// Currencies (fieldsPricesHS) and cost field are mapped from SAP by the mapping
// repository. Here we only decide which of them survive to HubSpot:
// - keepMappedPrice: keep currency values instead of letting the handler zero them.
// - dropCostField: drop the cost field so it is not inserted.
function applyPriceAndCostConfig(record, { keepMappedPrice, dropCostField, costField }) {
  let result = keepMappedPrice ? markRecordToKeepMappedPrice(record) : record;

  if (dropCostField && costField) {
    result = removeMappedField(result, costField);
  }

  return result;
}

export class OneToOneProductStrategy {
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
    strategyConfig = {},
  }) {
    const records = Array.isArray(mappedRecords) ? mappedRecords : [];
    const totalProducts = records.length;
    const requirePriceValue = strategyConfig.requirePrice?.value;
    const requireCostFlag = strategyConfig.requireCost?.flag;
    const costField = strategyConfig.requireCost?.field;
    const recordsToSend = records.map((record) => applyPriceAndCostConfig(record, {
      keepMappedPrice: requirePriceValue,
      dropCostField: !requireCostFlag,
      costField,
    }));

    this.logger.info?.({
      msg: 'Starting product sync strategy',
      tenantId,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
      totalProducts,
      requirePrice: requirePriceValue,
      requireCost: requireCostFlag,
      costField,
    });

    try {
      const result = await this.hubspotSyncTarget.send({
        mappedRecords: recordsToSend,
        config,
        objectType,
        tenantContext,
        credentials,
      });

      this.logger.info?.({
        msg: 'Finished product sync strategy',
        tenantId,
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
        totalProducts,
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
      });

      return {
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
        created: result?.created ?? 0,
        updated: result?.updated ?? Math.max((result?.sent ?? 0) - (result?.created ?? 0), 0),
        recordsProcessed: totalProducts,
      };
    } catch (error) {
      this.logger.error?.({
        msg: 'Product sync strategy failed',
        tenantId,
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
        totalProducts,
        error: error.message,
      });

      return {
        sent: 0,
        failed: totalProducts,
        created: 0,
        updated: 0,
        recordsProcessed: totalProducts,
      };
    }
  }
}

export default OneToOneProductStrategy;
