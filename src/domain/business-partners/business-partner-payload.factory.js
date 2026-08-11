import { BP_PAYLOAD_STRATEGIES } from './business-partner-creation.constants.js';

export class BusinessPartnerPayloadStrategyFactory {
  constructor({
    legacyStrategy,
    fullMappedStrategy,
    logger = console,
  }) {
    this.strategies = {
      [BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST]: legacyStrategy,
      [BP_PAYLOAD_STRATEGIES.FULL_MAPPED]: fullMappedStrategy,
    };
    this.logger = logger;
  }

  // Lanza a propósito: una strategy mal escrita en la config debe fallar antes
  // de que el webhook escriba nada en SAP, no a mitad del flujo.
  getStrategy(strategyName) {
    const normalizedStrategyName = String(strategyName ?? '').trim();

    if (Object.hasOwn(this.strategies, normalizedStrategyName)) {
      return this.strategies[normalizedStrategyName];
    }

    this.logger.error?.({
      msg: 'BusinessPartner payload strategy not supported',
      strategyName: normalizedStrategyName,
      validStrategies: Object.values(BP_PAYLOAD_STRATEGIES),
    });

    throw new Error(`BusinessPartner payload strategy not supported: ${normalizedStrategyName}`);
  }
}

export default BusinessPartnerPayloadStrategyFactory;
