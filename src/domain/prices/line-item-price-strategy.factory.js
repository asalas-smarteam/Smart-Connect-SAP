import { LINE_ITEM_PRICE_STRATEGIES } from './line-item-price-strategy.constants.js';

export class LineItemPriceStrategyFactory {
  constructor({
    businessPartnerStrategy,
    dealPriceListStrategy,
    logger = console,
  }) {
    this.strategies = {
      [LINE_ITEM_PRICE_STRATEGIES.BUSINESS_PARTNER]: businessPartnerStrategy,
      [LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST]: dealPriceListStrategy,
    };
    this.logger = logger;
  }

  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    if (Object.hasOwn(this.strategies, normalizedStrategyName)) {
      return this.strategies[normalizedStrategyName];
    }

    this.logger.error?.({
      msg: 'Line item price strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(LINE_ITEM_PRICE_STRATEGIES),
    });

    throw new Error(`Line item price strategy not supported: ${normalizedStrategyName}`);
  }
}

export default LineItemPriceStrategyFactory;
