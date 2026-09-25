import { jest } from '@jest/globals';
import { createSalesDocumentStrategy } from '../../../src/infrastructure/sap/salesDocuments/salesDocumentStrategyFactory.js';
import { S4SalesDocumentAdapter } from '../../../src/infrastructure/sap/salesDocuments/S4SalesDocumentAdapter.js';
import { B1SalesDocumentAdapter } from '../../../src/infrastructure/sap/salesDocuments/B1SalesDocumentAdapter.js';
import { S4DocumentBusinessPartnerResolver } from '../../../src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js';
import { B1DocumentBusinessPartnerResolver } from '../../../src/application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js';

function buildDeps() {
  return {
    quotationAdapter: { createQuotation: jest.fn() },
    hubspotWebhookAdapter: { getAccessToken: jest.fn(), updateBusinessPartnerIds: jest.fn() },
    runtimeRepository: { resolveDefaultFindSAP: jest.fn() },
    webhookReferenceRepository: { persistReferences: jest.fn() },
    businessPartnerPayloadStrategyFactory: { getStrategy: jest.fn() },
    salesDocumentConfigRepository: { getBusinessPartnerCreationConfig: jest.fn() },
    logger: { warn: jest.fn() },
  };
}

const SAP_CONFIG = { serviceLayerBaseUrl: 'https://vhmldqs4ci.example:44300' };

describe('createSalesDocumentStrategy', () => {
  it('devuelve el trío de S/4 para el flavor S4', () => {
    const strategy = createSalesDocumentStrategy({
      sapFlavor: 'S4', sapConfig: SAP_CONFIG, sapCallRecorder: null, deps: buildDeps(),
    });

    expect(strategy.salesDocumentAdapter).toBeInstanceOf(S4SalesDocumentAdapter);
    expect(strategy.documentBusinessPartnerResolver).toBeInstanceOf(S4DocumentBusinessPartnerResolver);
    expect(typeof strategy.salesDocumentBuilder.buildQuotationPayload).toBe('function');
  });

  it('devuelve el trío de B1 para el flavor B1', () => {
    const strategy = createSalesDocumentStrategy({
      sapFlavor: 'B1', sapConfig: SAP_CONFIG, sapCallRecorder: null, deps: buildDeps(),
    });

    expect(strategy.salesDocumentAdapter).toBeInstanceOf(B1SalesDocumentAdapter);
    expect(strategy.documentBusinessPartnerResolver).toBeInstanceOf(B1DocumentBusinessPartnerResolver);
  });

  // Un tenant sin la llave sapFlavor (los cuatro de producción) tiene que seguir por B1.
  it('cae a B1 con flavor ausente o inválido', () => {
    for (const sapFlavor of [undefined, null, '', 'CUALQUIERA']) {
      const strategy = createSalesDocumentStrategy({
        sapFlavor, sapConfig: SAP_CONFIG, sapCallRecorder: null, deps: buildDeps(),
      });
      expect(strategy.salesDocumentAdapter).toBeInstanceOf(B1SalesDocumentAdapter);
    }
  });
});
