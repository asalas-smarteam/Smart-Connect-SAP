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
    // hasOwn evita que 'constructor' o 'toString' resuelvan a un valor de la
    // cadena de prototipos en vez de lanzar; el truthy evita devolver undefined
    // cuando la llave existe pero la strategy no se inyectó.
    const strategy = Object.hasOwn(this.strategies, normalizedStrategyName)
      && this.strategies[normalizedStrategyName];

    if (strategy) {
      return strategy;
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
