import lineItemPriceWebhookService from './lineItemPriceWebhook.service.js';
import dealPriceListLineItemPriceWebhookService from './dealPriceListLineItemPriceWebhook.service.js';
import LineItemPriceStrategyFactory from '#domain/prices/line-item-price-strategy.factory.js';
import LineItemPriceStrategyConfigRepository from '#infrastructure/config/LineItemPriceStrategyConfigRepository.js';
import logger from '../logger/logger.js';

export class LineItemPriceWebhookPayloadAdapter {
  constructor({
    strategyConfigRepository = new LineItemPriceStrategyConfigRepository(),
    strategyFactory = new LineItemPriceStrategyFactory({
      businessPartnerStrategy: lineItemPriceWebhookService,
      dealPriceListStrategy: dealPriceListLineItemPriceWebhookService,
      logger,
    }),
  } = {}) {
    this.strategyConfigRepository = strategyConfigRepository;
    this.strategyFactory = strategyFactory;
  }

  async preparePayload(payload, context) {
    const strategyConfig = await this.strategyConfigRepository.getLineItemPriceStrategyConfig({
      tenantModels: context?.tenantModels,
    });
    const strategy = this.strategyFactory.getStrategy(strategyConfig.strategy);

    return strategy.preparePayload(payload, { ...context, strategyConfig });
  }

  markAsSent(LineItemPriceWebhookEvent, executionId) {
    return lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, executionId);
  }

  markAsError(LineItemPriceWebhookEvent, executionId, error) {
    return lineItemPriceWebhookService.markAsError(LineItemPriceWebhookEvent, executionId, error);
  }
}

export const lineItemPriceWebhookPayloadAdapter = new LineItemPriceWebhookPayloadAdapter();

export default lineItemPriceWebhookPayloadAdapter;
