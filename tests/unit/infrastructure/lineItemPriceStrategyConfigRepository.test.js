import { jest } from '@jest/globals';
import { LineItemPriceStrategyConfigRepository } from '../../../src/infrastructure/config/LineItemPriceStrategyConfigRepository.js';
import {
  DEFAULT_LINE_ITEM_PRICE_STRATEGY,
  LINE_ITEM_PRICE_STRATEGIES,
} from '../../../src/domain/prices/line-item-price-strategy.constants.js';

function buildTenantModels(configValue) {
  return {
    Configuration: {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(
          configValue === undefined ? null : { key: 'lineItemPriceStrategy', value: configValue }
        ),
      }),
    },
  };
}

describe('LineItemPriceStrategyConfigRepository', () => {
  const repository = new LineItemPriceStrategyConfigRepository();

  it('returns the default (legacy) strategy when the config does not exist', async () => {
    const config = await repository.getLineItemPriceStrategyConfig({
      tenantModels: buildTenantModels(undefined),
    });

    expect(config.strategy).toBe(DEFAULT_LINE_ITEM_PRICE_STRATEGY);
    expect(config.strategy).toBe(LINE_ITEM_PRICE_STRATEGIES.BUSINESS_PARTNER);
  });

  it('returns the default strategy when tenant models are unavailable', async () => {
    const config = await repository.getLineItemPriceStrategyConfig({ tenantModels: {} });

    expect(config.strategy).toBe(DEFAULT_LINE_ITEM_PRICE_STRATEGY);
  });

  it('normalizes an object config merging deal price list defaults', async () => {
    const config = await repository.getLineItemPriceStrategyConfig({
      tenantModels: buildTenantModels({
        strategy: LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST,
        dealPriceListProperty: 'lista_de_precios',
        lineItemPriceListProperty: 'lista_de_precios',
        currencyCodes: { GTQ: 'QTZ', USD: 'USD' },
      }),
    });

    expect(config).toMatchObject({
      strategy: LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST,
      dealPriceListProperty: 'lista_de_precios',
      lineItemPriceListProperty: 'lista_de_precios',
      dealCurrencyProperty: 'deal_currency_code',
      safePriceProperty: 'safe_price_value',
      currencyCodes: { GTQ: 'QTZ', USD: 'USD' },
    });
  });

  it('accepts a plain string strategy name', async () => {
    const config = await repository.getLineItemPriceStrategyConfig({
      tenantModels: buildTenantModels(LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST),
    });

    expect(config.strategy).toBe(LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST);
  });

  it('parses a JSON string config', async () => {
    const config = await repository.getLineItemPriceStrategyConfig({
      tenantModels: buildTenantModels(
        JSON.stringify({
          strategy: LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST,
          dealPriceListProperty: 'lista',
        })
      ),
    });

    expect(config.strategy).toBe(LINE_ITEM_PRICE_STRATEGIES.DEAL_PRICE_LIST);
    expect(config.dealPriceListProperty).toBe('lista');
  });
});
