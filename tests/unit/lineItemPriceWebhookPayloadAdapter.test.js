import { jest } from '@jest/globals';
import { LineItemPriceWebhookPayloadAdapter } from '../../src/infrastructure/webhook/LineItemPriceWebhookPayloadAdapter.js';

describe('LineItemPriceWebhookPayloadAdapter strategy dispatch', () => {
  function buildAdapter(strategyConfig) {
    const businessPartnerStrategy = {
      preparePayload: jest.fn().mockResolvedValue({ handledBy: 'businessPartner' }),
    };
    const dealPriceListStrategy = {
      preparePayload: jest.fn().mockResolvedValue({ handledBy: 'dealPriceList' }),
    };
    const adapter = new LineItemPriceWebhookPayloadAdapter({
      strategyConfigRepository: {
        getLineItemPriceStrategyConfig: jest.fn().mockResolvedValue(strategyConfig),
      },
      strategyFactory: {
        getStrategy: jest.fn().mockImplementation((name) => {
          if (name === 'businessPartner_LineItemPrice') return businessPartnerStrategy;
          if (name === 'dealPriceList_LineItemPrice') return dealPriceListStrategy;
          throw new Error(`unexpected strategy ${name}`);
        }),
      },
    });

    return { adapter, businessPartnerStrategy, dealPriceListStrategy };
  }

  it('routes to the legacy strategy by default', async () => {
    const { adapter, businessPartnerStrategy, dealPriceListStrategy } = buildAdapter({
      strategy: 'businessPartner_LineItemPrice',
    });
    const context = { tenantModels: {}, tenant: {}, tenantKey: 'tenant_1' };

    const result = await adapter.preparePayload({ some: 'payload' }, context);

    expect(result).toEqual({ handledBy: 'businessPartner' });
    expect(businessPartnerStrategy.preparePayload).toHaveBeenCalledWith(
      { some: 'payload' },
      expect.objectContaining({
        ...context,
        strategyConfig: { strategy: 'businessPartner_LineItemPrice' },
      })
    );
    expect(dealPriceListStrategy.preparePayload).not.toHaveBeenCalled();
  });

  it('routes to the dealPriceList strategy when configured', async () => {
    const strategyConfig = {
      strategy: 'dealPriceList_LineItemPrice',
      dealPriceListProperty: 'lista_de_precios',
    };
    const { adapter, businessPartnerStrategy, dealPriceListStrategy } = buildAdapter(strategyConfig);

    const result = await adapter.preparePayload({ some: 'payload' }, { tenantModels: {} });

    expect(result).toEqual({ handledBy: 'dealPriceList' });
    expect(dealPriceListStrategy.preparePayload).toHaveBeenCalledWith(
      { some: 'payload' },
      expect.objectContaining({ strategyConfig })
    );
    expect(businessPartnerStrategy.preparePayload).not.toHaveBeenCalled();
  });
});
