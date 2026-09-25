import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
  normalizeSapFlavor,
} from '#domain/sap/sap-flavor.constants.js';
import { assertPort } from '#application/ports/port-validator.js';
import { SapSalesDocumentPort } from '#application/ports/sap/sap-sales-document.port.js';
import { SalesDocumentBuilderPort } from '#application/ports/sap/sales-document-builder.port.js';
import { SapDocumentBusinessPartnerPort } from '#application/ports/sap/sap-document-business-partner.port.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import { buildQuotationPayload } from '#domain/orders/order-builder.service.js';
import { buildS4QuotationPayload } from '#domain/orders/s4-sales-document-builder.service.js';
import { B1SalesDocumentAdapter } from './B1SalesDocumentAdapter.js';
import { S4SalesDocumentAdapter } from './S4SalesDocumentAdapter.js';
import { wrapS4TransportWithRecorder } from './recordedS4Transport.js';
import { S4DocumentBusinessPartnerResolver } from '../customers/S4DocumentBusinessPartnerResolver.js';
import { B1DocumentBusinessPartnerResolver } from '#application/use-cases/businessPartner/B1DocumentBusinessPartnerResolver.js';

// Los builders son funciones puras; el puerto pide un objeto con el método, así que se
// envuelven acá en vez de convertirlos en clases y tocar el builder de B1 que ya corre.
function wrapBuilder(build) {
  return { buildQuotationPayload: build };
}

// Devuelve el TRÍO junto a propósito: resolver, builder y adapter tienen que hablar el mismo
// modelo de entidades. Si se pidieran por separado, nada impediría combinar el builder de B1
// con el adapter de S/4, y el error aparecería recién como un rechazo del gateway.
export function createSalesDocumentStrategy({ sapFlavor, sapConfig, sapCallRecorder, deps }) {
  const flavor = normalizeSapFlavor(sapFlavor) || DEFAULT_SAP_FLAVOR;

  if (flavor === SAP_FLAVORS.S4) {
    const transport = wrapS4TransportWithRecorder(
      createSapTransport({ sapFlavor: SAP_FLAVORS.S4, config: sapConfig }),
      sapCallRecorder
    );

    return {
      documentBusinessPartnerResolver: assertPort(
        new S4DocumentBusinessPartnerResolver({
          transport,
          runtimeRepository: deps.runtimeRepository,
          salesDocumentConfigRepository: deps.salesDocumentConfigRepository,
          hubspotWebhookAdapter: deps.hubspotWebhookAdapter,
          webhookReferenceRepository: deps.webhookReferenceRepository,
          logger: deps.logger,
        }),
        SapDocumentBusinessPartnerPort
      ),
      salesDocumentBuilder: assertPort(wrapBuilder(buildS4QuotationPayload), SalesDocumentBuilderPort),
      salesDocumentAdapter: assertPort(new S4SalesDocumentAdapter({ transport }), SapSalesDocumentPort),
    };
  }

  return {
    documentBusinessPartnerResolver: assertPort(
      new B1DocumentBusinessPartnerResolver({
        hubspotWebhookAdapter: deps.hubspotWebhookAdapter,
        runtimeRepository: deps.runtimeRepository,
        webhookReferenceRepository: deps.webhookReferenceRepository,
        businessPartnerPayloadStrategyFactory: deps.businessPartnerPayloadStrategyFactory,
        logger: deps.logger,
      }),
      SapDocumentBusinessPartnerPort
    ),
    salesDocumentBuilder: assertPort(wrapBuilder(buildQuotationPayload), SalesDocumentBuilderPort),
    salesDocumentAdapter: assertPort(
      new B1SalesDocumentAdapter({ quotationAdapter: deps.quotationAdapter }),
      SapSalesDocumentPort
    ),
  };
}

export default createSalesDocumentStrategy;
