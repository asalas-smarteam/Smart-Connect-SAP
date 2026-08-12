import BusinessPartnerPayloadStrategyFactory
  from '../../../src/domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import FullMappedBusinessPartnerPayloadStrategy
  from '../../../src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { BusinessPartnerPayloadStrategyPort }
  from '../../../src/application/ports/sap/business-partner-payload-strategy.port.js';
import { BP_PAYLOAD_STRATEGIES }
  from '../../../src/domain/business-partners/business-partner-creation.constants.js';

describe('cableado del factory de strategies de payload', () => {
  it('ambas strategies cumplen el puerto y el factory las resuelve', () => {
    const factory = new BusinessPartnerPayloadStrategyFactory({
      legacyStrategy: assertPort(
        new LegacyWhitelistBusinessPartnerPayloadStrategy(),
        BusinessPartnerPayloadStrategyPort
      ),
      fullMappedStrategy: assertPort(
        new FullMappedBusinessPartnerPayloadStrategy(),
        BusinessPartnerPayloadStrategyPort
      ),
    });

    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.LEGACY_WHITELIST).includesContactEmployeesInCreate())
      .toBe(false);
    expect(factory.getStrategy(BP_PAYLOAD_STRATEGIES.FULL_MAPPED).includesContactEmployeesInCreate())
      .toBe(true);
  });
});
