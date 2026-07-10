import { jest } from '@jest/globals';
import { LineItemPriceStrategyFactory } from '../../../src/domain/prices/line-item-price-strategy.factory.js';
import { LINE_ITEM_PRICE_STRATEGIES } from '../../../src/domain/prices/line-item-price-strategy.constants.js';

describe('LineItemPriceStrategyFactory', () => {
  const businessPartnerStrategy = { name: 'businessPartner' };
  const dealPriceListStrategy = { name: 'dealPriceList' };

  function buildFactory() {
    return new LineItemPriceStrategyFactory({
      businessPartnerStrategy,
      dealPriceListStrategy,
      logger: { error: jest.fn() },
    });
  }

  it('returns the business partner strategy', () => {
    expect(
      buildFactory().getStrategy(LINE_ITEM_PRICE_STRATEGIES.BUSINESS_PARTNER)
    ).toBe(businessPartnerStrategy);
  });

  it('returns the deal price list strategy', () => {
    expect(
      buildFactory().getStrategy(LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST)
    ).toBe(dealPriceListStrategy);
  });

  it('throws for unknown strategies', () => {
    expect(() => buildFactory().getStrategy('unknown')).toThrow(
      'Line item price strategy not supported: unknown'
    );
  });
});
