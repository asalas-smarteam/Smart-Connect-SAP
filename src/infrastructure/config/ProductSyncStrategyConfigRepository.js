import {
  DEFAULT_PRODUCT_SYNC_STRATEGY,
  PRODUCT_SYNC_CONFIG_KEY,
} from '#domain/products/product-sync-strategy.constants.js';

function parseJsonString(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function normalizeStrategyConfig(value) {
  if (!value) {
    return { strategy: DEFAULT_PRODUCT_SYNC_STRATEGY };
  }

  if (typeof value === 'string') {
    const parsed = parseJsonString(value);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeStrategyConfig(parsed);
    }

    return { strategy: value.trim() || DEFAULT_PRODUCT_SYNC_STRATEGY };
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      ...value,
      strategy: value.strategy || DEFAULT_PRODUCT_SYNC_STRATEGY,
    };
  }

  return { strategy: DEFAULT_PRODUCT_SYNC_STRATEGY };
}

export class ProductSyncStrategyConfigRepository {
  async getProductSyncStrategyConfig({ tenantModels }) {
    const Configuration = tenantModels?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return { strategy: DEFAULT_PRODUCT_SYNC_STRATEGY };
    }

    const query = Configuration.findOne({ key: PRODUCT_SYNC_CONFIG_KEY });
    const configuration = typeof query?.lean === 'function'
      ? await query.lean()
      : await query;

    return normalizeStrategyConfig(configuration?.value);
  }
}

export default ProductSyncStrategyConfigRepository;
