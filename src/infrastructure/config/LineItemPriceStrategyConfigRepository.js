import {
  DEFAULT_DEAL_PRICE_LIST_CONFIG,
  DEFAULT_LINE_ITEM_PRICE_STRATEGY,
  LINE_ITEM_PRICE_STRATEGY_CONFIG_KEY,
} from '#domain/prices/line-item-price-strategy.constants.js';

function parseJsonString(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function normalizeStrategyConfig(value) {
  if (!value) {
    return { ...DEFAULT_DEAL_PRICE_LIST_CONFIG, strategy: DEFAULT_LINE_ITEM_PRICE_STRATEGY };
  }

  if (typeof value === 'string') {
    const parsed = parseJsonString(value);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeStrategyConfig(parsed);
    }

    return {
      ...DEFAULT_DEAL_PRICE_LIST_CONFIG,
      strategy: value.trim() || DEFAULT_LINE_ITEM_PRICE_STRATEGY,
    };
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      ...DEFAULT_DEAL_PRICE_LIST_CONFIG,
      ...value,
      strategy: value.strategy || DEFAULT_LINE_ITEM_PRICE_STRATEGY,
    };
  }

  return { ...DEFAULT_DEAL_PRICE_LIST_CONFIG, strategy: DEFAULT_LINE_ITEM_PRICE_STRATEGY };
}

export class LineItemPriceStrategyConfigRepository {
  async getLineItemPriceStrategyConfig({ tenantModels }) {
    const Configuration = tenantModels?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return normalizeStrategyConfig(null);
    }

    const query = Configuration.findOne({ key: LINE_ITEM_PRICE_STRATEGY_CONFIG_KEY });
    const configuration = typeof query?.lean === 'function'
      ? await query.lean()
      : await query;

    return normalizeStrategyConfig(configuration?.value);
  }
}

export default LineItemPriceStrategyConfigRepository;
