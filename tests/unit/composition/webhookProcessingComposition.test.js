import {
  buildProcessHubspotConvertQuotationToOrderUseCase,
  buildProcessHubspotCreateQuotationUseCase,
  buildProcessHubspotInventoryTransferRequestUseCase,
  buildProcessHubspotPurchaseQuotationUseCase,
  buildProcessHubspotUpdateQuotationUseCase,
  buildProcessHubspotWebhookEventUseCase,
} from '../../../src/composition/webhook-processing.composition.js';
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

// GUARDIA DE CABLEADO: los use cases traen un grabador no-op por defecto para poder
// construirse sueltos en tests, asi que si composition se olvida de inyectar el real todo
// sigue verde y en produccion sapAudit vuelve a quedarse sin el trafico. Se verifica por
// comportamiento (el real intercepta `request`, el no-op devuelve el adapter tal cual), no
// por identidad de la funcion.
describe('cableado del grabador de trafico SAP', () => {
  const useCases = [
    ['createDeal', buildProcessHubspotWebhookEventUseCase],
    ['createQuotation', buildProcessHubspotCreateQuotationUseCase],
    ['updateQuotation', buildProcessHubspotUpdateQuotationUseCase],
    ['convertQuotationToOrder', buildProcessHubspotConvertQuotationToOrderUseCase],
    ['inventoryTransferRequest', buildProcessHubspotInventoryTransferRequestUseCase],
    ['purchaseQuotation', buildProcessHubspotPurchaseQuotationUseCase],
  ];

  it.each(useCases)('%s recibe un grabador que si graba', async (_name, build) => {
    const recorder = build().createSapCallRecorder();
    const adapter = { request: async () => ({ DocEntry: 1 }) };
    const wrapped = recorder.wrap(adapter);

    expect(wrapped).not.toBe(adapter);

    await wrapped.request({}, { method: 'post', path: '/Orders', data: { CardCode: 'CL001' } });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      method: 'POST',
      path: '/Orders',
      request: { CardCode: 'CL001' },
      ok: true,
    });
  });
});
