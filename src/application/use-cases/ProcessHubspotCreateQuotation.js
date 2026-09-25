import {
  buildQuotationPayload,
  mapDocumentLines,
  mapHubspotToSapFields,
  resolvePaymentGroupCode,
} from '#domain/orders/order-builder.service.js';
import {
  resolveDealContactEmployeeCode,
  resolveEventPayload,
} from '../services/webhook-payload.service.js';
import {
  buildSapDocumentLinkLines,
  createDocumentAuditTrail,
  mergeHubspotResponses,
  resolveDocumentSalesPersonId,
  resolveDocumentSlpCode,
  resolveDocumentsOwnerCode,
} from './webhookQuotationSupport.js';
import { createNoopSapCallRecorder } from '../services/sap-call-audit.service.js';
import { BusinessPartnerPayloadStrategyFactory } from '#domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import FullMappedBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { B1DocumentBusinessPartnerResolver } from './businessPartner/B1DocumentBusinessPartnerResolver.js';
import {
  resolveS4HeaderFieldValue,
  resolveS4RequiredHeaderFields,
} from '#domain/orders/s4-sales-document-builder.service.js';
import { SAP_FLAVORS, normalizeSapFlavor } from '#domain/sap/sap-flavor.constants.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';

// Dead in production since composition always passes an explicit factory (see
// webhook-processing.composition.js). Kept only as a defensive default for direct
// construction, e.g. tests that don't go through composition: it keeps the payload
// byte-for-byte identical to what the adapter built before payload strategies existed.
function createDefaultBusinessPartnerPayloadStrategyFactory() {
  return new BusinessPartnerPayloadStrategyFactory({
    legacyStrategy: new LegacyWhitelistBusinessPartnerPayloadStrategy(),
    fullMappedStrategy: new FullMappedBusinessPartnerPayloadStrategy(),
  });
}

// Dead in production since composition always passes createSalesDocumentStrategy (see
// webhook-processing.composition.js), which knows how to build the real S/4 trio too.
// Kept only as a defensive default for direct construction (tests that build this class
// without composition). This use case lives under application/, so it may NOT import
// createSalesDocumentStrategy or the S/4 infrastructure adapters directly -- that would
// cross the hexagonal boundary application/ is not allowed to cross (only composition may
// wire infrastructure in; see tests/unit/architecture/hexagonalBoundaries.test.js). This
// fallback therefore always builds the B1 trio out of pieces application/domain already
// own, calling the exact same resolveBusinessPartnerForDocument / buildQuotationPayload /
// quotationAdapter.createQuotation this file called directly before this task, so existing
// callers that never inject a factory keep their byte-for-byte behavior.
//
// Para S/4 NO hay trío que armar desde acá (sus tres piezas viven en infraestructura), así que
// falla diciéndolo. Devolver el trío de B1 ignorando el sabor daba un HÍBRIDO: builder de
// Business One, cero posiciones (el caso de uso fuerza `documentLines: []` para S/4) y el
// documento persistido con el vocabulario de S/4. Esa mezcla es exactamente lo que el trío
// existe para impedir, y en silencio se veía como una ejecución exitosa.
function createDefaultSalesDocumentStrategyFactory({ sapFlavor, deps }) {
  if (normalizeSapFlavor(sapFlavor) === SAP_FLAVORS.S4) {
    throw new Error(
      'ProcessHubspotCreateQuotation no puede armar el trío de S/4 por defecto: inyectá createSalesDocumentStrategy desde la composición (webhook-processing.composition.js)'
    );
  }

  return {
    documentBusinessPartnerResolver: new B1DocumentBusinessPartnerResolver({
      hubspotWebhookAdapter: deps.hubspotWebhookAdapter,
      runtimeRepository: deps.runtimeRepository,
      webhookReferenceRepository: deps.webhookReferenceRepository,
      businessPartnerPayloadStrategyFactory: deps.businessPartnerPayloadStrategyFactory,
      logger: deps.logger,
    }),
    salesDocumentBuilder: { buildQuotationPayload },
    salesDocumentAdapter: {
      createQuotation: (args) => deps.quotationAdapter.createQuotation(args),
    },
  };
}

// Mismo motivo que arriba: reflejan los defaults reales de S4SalesDocumentConfigRepository /
// WarehouseStockConfigRepository (infraestructura) sin importar esos archivos. Nunca corren en
// producción -- composición siempre inyecta las instancias reales.
function createDefaultSalesDocumentConfigRepository() {
  return {
    async getSalesDocumentConfig() {
      return {
        quotationType: null,
        salesOrganization: null,
        distributionChannel: null,
        division: null,
        salesPersonPartnerFunction: null,
        priceConditionType: null,
      };
    },
  };
}

function createDefaultWarehouseStockConfigRepository() {
  return {
    async getWarehouseStockConfig() {
      return { rawFields: null };
    },
  };
}

export class ProcessHubspotCreateQuotation {
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    sapQuotationAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    sapDocumentLinkRepository,
    businessPartnerPayloadStrategyFactory = createDefaultBusinessPartnerPayloadStrategyFactory(),
    salesDocumentStrategyFactory = createDefaultSalesDocumentStrategyFactory,
    salesDocumentConfigRepository = createDefaultSalesDocumentConfigRepository(),
    warehouseStockConfigRepository = createDefaultWarehouseStockConfigRepository(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    createSapCallRecorder = createNoopSapCallRecorder,
    logger = { warn: () => {} },
  }) {
    this.createSapCallRecorder = createSapCallRecorder;
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.sapQuotationAdapter = sapQuotationAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.businessPartnerPayloadStrategyFactory = businessPartnerPayloadStrategyFactory;
    this.salesDocumentStrategyFactory = salesDocumentStrategyFactory;
    this.salesDocumentConfigRepository = salesDocumentConfigRepository;
    this.warehouseStockConfigRepository = warehouseStockConfigRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSapAudit = buildWebhookSapAudit;
    this.logger = logger;
  }

  async execute({ event, tenantModels, tenantId, tenantKey, portalId }) {
    const { payload, deal, company, contact, lineItems, contactEmployees, bpAddress } = resolveEventPayload(event);
    const WebhookEvent = tenantModels?.WebhookEvent;
    const SapDocumentLink = tenantModels?.SapDocumentLink;
    const companyExists = Boolean(company);
    const contactExists = Boolean(contact);
    const dealId = toNonEmptyString(deal?.hs_object_id);
    const sapCallRecorder = this.createSapCallRecorder();
    const auditTrail = createDocumentAuditTrail(payload, 'quotation', sapCallRecorder.calls);
    const sapOrderAdapter = sapCallRecorder.wrap(this.sapOrderAdapter);
    let quotationResponse = null;
    let cardCode = null;

    try {
      const context = await this.runtimeRepository.resolveRuntimeContext({
        tenantModels,
        payload,
        tenantId,
        tenantKey,
        portalId,
      });
      context.tenantModels = tenantModels;

      const { mappings, sapConfig, hubspotCredentials, taxCodes, miscPriceCalculationConfig, discountConfig } = context;

      // El trío se arma UNA vez por ejecución: resolver, builder y adapter tienen que hablar
      // el mismo modelo. El quotationAdapter que se le pasa va ya envuelto por el grabador,
      // que es lo que preserva la auditoría que antes daba el wrap suelto de más arriba.
      const { documentBusinessPartnerResolver, salesDocumentBuilder, salesDocumentAdapter } =
        this.salesDocumentStrategyFactory({
          sapFlavor: context.sapFlavor,
          sapConfig,
          sapCallRecorder,
          deps: {
            quotationAdapter: sapCallRecorder.wrap(this.sapQuotationAdapter),
            hubspotWebhookAdapter: this.hubspotWebhookAdapter,
            runtimeRepository: this.runtimeRepository,
            webhookReferenceRepository: this.webhookReferenceRepository,
            businessPartnerPayloadStrategyFactory: this.businessPartnerPayloadStrategyFactory,
            salesDocumentConfigRepository: this.salesDocumentConfigRepository,
            logger: this.logger,
          },
        });

      // Idempotency: do not create a second quotation for the same deal.
      const existingLink = await this.sapDocumentLinkRepository.findByDeal({
        SapDocumentLink,
        hubspotCredentialId: hubspotCredentials._id,
        dealId,
        documentType: 'quotation',
      });

      if (existingLink) {
        this.logger.info?.({
          msg: 'Quotation already exists for deal, skipping creation',
          dealId,
          sapDocEntry: existingLink.sapDocEntry,
        });
        auditTrail.skipped = {
          reason: 'quotation_already_exists',
          sapDocEntry: existingLink.sapDocEntry ?? null,
          sapDocNum: existingLink.sapDocNum ?? null,
        };
        return {
          cardCode: existingLink.cardCode,
          docEntry: existingLink.sapDocEntry,
          docNum: existingLink.sapDocNum,
          dealId,
          sapAudit: this.buildWebhookSapAudit(auditTrail),
        };
      }

      // El área de ventas se resuelve ANTES del alta del cliente: el deep create de S/4 registra
      // al cliente en esa área, y resolverla después dejaría al cliente nuevo en un área distinta
      // de la del documento (SAP rechazaría la oferta con "cliente no existe en el área de
      // ventas"). mappedDeal se calcula acá (antes se calculaba más abajo) porque salesArea lo
      // necesita; se reutiliza sin recalcular en la construcción del payload, más abajo.
      const mappedDeal = mapHubspotToSapFields(
        deal || {},
        mappings.dealOrdersQuotationsMappings,
        { logger: this.logger }
      );
      const salesDocumentConfig = await this.salesDocumentConfigRepository
        .getSalesDocumentConfig({ tenantModels });

      // Los CUATRO campos de cabecera obligatorios de S/4 se validan juntos y ANTES de resolver
      // al cliente. El área de ventas ya se validaba antes del alta, pero la clase de documento
      // solo la miraba el builder, que corre DESPUÉS: a un tenant al que solo le faltara ese
      // dato se le creaba el socio de negocio en el maestro de clientes de SAP y recién ahí
      // fallaba, con un error permanente y sin reintento, dejando un cliente huérfano por
      // intento. Es la MISMA función que usa el builder, no una segunda comprobación.
      if (context.sapFlavor === SAP_FLAVORS.S4) {
        resolveS4RequiredHeaderFields({ mappedDealFields: mappedDeal, salesDocumentConfig });
      }

      // Misma precedencia mapeo -> default que aplica el builder, resuelta por la misma
      // función: en B1 este objeto no lo mira nadie (el resolver de B1 lo ignora).
      const salesArea = {
        salesOrganization: resolveS4HeaderFieldValue(mappedDeal, salesDocumentConfig.salesOrganization, 'SalesOrganization'),
        distributionChannel: resolveS4HeaderFieldValue(mappedDeal, salesDocumentConfig.distributionChannel, 'DistributionChannel'),
        division: resolveS4HeaderFieldValue(mappedDeal, salesDocumentConfig.division, 'OrganizationDivision'),
      };

      const businessPartner = await documentBusinessPartnerResolver.findOrCreateForDocument({
        sapOrderAdapter,
        WebhookEvent,
        eventId: event?._id,
        payload,
        company,
        contact,
        companyExists,
        contactExists,
        contactEmployees,
        bpAddress,
        context,
        auditTrail,
        salesArea,
      });
      cardCode = businessPartner.cardCode;
      const {
        contactEmployeeResult,
        contactEmployeeFailures,
        hubspotToken,
        dealContactIsContactEmployee,
      } = businessPartner;

      // En S/4 las posiciones las arma el propio builder desde los lineItems crudos; mapDocumentLines
      // es exclusivamente de B1 (su forma de línea no significa nada para el builder de S/4).
      const documentLines = context.sapFlavor === SAP_FLAVORS.S4 ? [] : mapDocumentLines({
        lineItems,
        productMappings: mappings.productMappings,
        lineMappings: mappings.productOrdersQuotationsMappings,
        taxCodes,
        miscPriceCalculationConfig,
        discountConfig,
        logger: this.logger,
      });
      const slpCode = await resolveDocumentSlpCode({
        runtimeRepository: this.runtimeRepository,
        tenantModels,
        deal,
        hubspotCredentials,
        logger: this.logger,
      });
      // Digitador. Devuelve null salvo que el tenant tenga el mapeo DocumentsOwner en su
      // contexto deal/orders-quotations, asi que los demas tenants no cambian de payload.
      const documentsOwner = await resolveDocumentsOwnerCode({
        runtimeRepository: this.runtimeRepository,
        tenantModels,
        deal,
        dealMappings: mappings.dealOrdersQuotationsMappings,
        hubspotCredentials,
        logger: this.logger,
      });
      const { rawFields: warehouseFields } = await this.warehouseStockConfigRepository
        .getWarehouseStockConfig({ tenantModels });
      const groupCodeDefaults = await this.runtimeRepository.resolveGroupCodeDefaults(tenantModels);
      // resolveDocumentSlpCode exige un entero (correcto para el SlpCode de B1) y por eso no
      // sirve para el Personnel Number de S/4, que puede traer ceros a la izquierda o no ser
      // numérico. La lectura extra solo corre en el camino de S/4.
      const salesPersonId = context.sapFlavor === SAP_FLAVORS.S4
        ? await resolveDocumentSalesPersonId({
          runtimeRepository: this.runtimeRepository,
          tenantModels,
          deal,
          hubspotCredentials,
          logger: this.logger,
        })
        : null;

      // Un solo objeto de argumentos con las claves de los dos flavors: cada builder
      // desestructura lo suyo e ignora el resto, igual que ya hacen las funciones de
      // order-builder.service.js con sus parámetros opcionales. Así el caso de uso no necesita
      // un `if` de flavor para construir el payload.
      const quotationPayload = salesDocumentBuilder.buildQuotationPayload({
        // B1
        cardCode,
        documentLines,
        slpCode,
        documentsOwner,
        paymentGroupCode: resolvePaymentGroupCode({ mappedDeal, groupCodeDefaults }),
        mappedDealFields: mappedDeal,
        // S/4
        soldToParty: cardCode,
        lineItems,
        productMappings: mappings.productMappings,
        lineMappings: mappings.productOrdersQuotationsMappings,
        salesDocumentConfig,
        warehouseFields: Array.isArray(warehouseFields) ? warehouseFields : [],
        salesPersonId,
        logger: this.logger,
      });
      auditTrail.payload_SAP.quotation = quotationPayload;

      quotationResponse = await salesDocumentAdapter.createQuotation({
        sapConfig,
        quotationPayload,
      });
      auditTrail.response_SAP.quotation = quotationResponse;

      // En S/4 `documentLines` es [] (el builder arma las posiciones desde lineItems crudos), así
      // que sin esta proyección buildSapDocumentLinkLines caería siempre a sus valores de
      // respaldo: warehouseCode terminaría guardando el value crudo de HubSpot (p.ej.
      // 'mqgt_0008_stock') en vez del código de bodega de SAP, y las actualizaciones/conversiones
      // posteriores leen ese campo esperando vocabulario de SAP en los dos flavors. Se proyecta
      // desde `to_Item`, que quedó alineado por índice con `lineItems` al construirse (un item por
      // lineItem, mismo orden, sin saltos). El camino de B1 no cambia: sigue recibiendo el mismo
      // array `documentLines` de siempre.
      const linkDocumentLines = context.sapFlavor === SAP_FLAVORS.S4
        ? (Array.isArray(quotationPayload.to_Item) ? quotationPayload.to_Item : []).map((item) => ({
          ItemCode: item.Material ?? null,
          Quantity: item.RequestedQuantity ?? null,
          // El precio unitario no se manda en el payload de S/4 (SAP lo resuelve con sus propias
          // condiciones de pricing vía to_PricingElement), así que null acá es correcto -- no es
          // un dato que se perdió en la proyección.
          UnitPrice: null,
          WarehouseCode: item.Plant ?? null,
        }))
        : documentLines;

      const linkLines = buildSapDocumentLinkLines({
        lineItems,
        documentLines: linkDocumentLines,
        responseLines: quotationResponse?.DocumentLines,
      });

      await this.sapDocumentLinkRepository.create({
        SapDocumentLink,
        link: {
          portalId: toNonEmptyString(payload?.portalId || portalId),
          dealId,
          clientConfigId: hubspotCredentials.clientConfigId,
          hubspotCredentialId: hubspotCredentials._id,
          cardCode,
          documentType: 'quotation',
          sapObject: context.sapFlavor === SAP_FLAVORS.S4 ? 'A_SalesQuotation' : 'Quotations',
          sapDocEntry: quotationResponse?.DocEntry ?? null,
          sapDocNum: quotationResponse?.DocNum ?? null,
          // BaseType 23 es de B1: identifica la oferta como documento base de una conversión. En
          // S/4 no significa nada, y guardarlo haría creer que se puede convertir por ese camino.
          sapBaseType: context.sapFlavor === SAP_FLAVORS.S4 ? null : 23,
          status: 'created',
          lines: linkLines,
        },
      });

      const hubspotFinalResponses = await this.hubspotWebhookAdapter.updateAfterSap({
        tenantModels,
        hubspotCredentials,
        token: hubspotToken,
        payload,
        dealMappings: mappings.dealMappings,
        orderResponse: quotationResponse,
        cardCode,
        syncCompany: false,
        syncContact: contactExists && contactEmployeeResult.created,
        contactEmployeeCode: resolveDealContactEmployeeCode({
          dealContactIsContactEmployee,
          internalCodes: contactEmployeeResult.internalCodes,
        }),
      });
      auditTrail.response_hubspot = mergeHubspotResponses(
        auditTrail.response_hubspot,
        hubspotFinalResponses
      );

      return {
        cardCode,
        docEntry: quotationResponse?.DocEntry ?? null,
        docNum: quotationResponse?.DocNum ?? null,
        dealId,
        contactEmployeeFailures,
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
      }

      if (quotationResponse) {
        error.sapOrderCreated = true;
        error.sapOrderResult = {
          cardCode,
          docEntry: quotationResponse?.DocEntry ?? null,
          docNum: quotationResponse?.DocNum ?? null,
        };
      }

      error.syncLogWebhookErrors = [
        this.buildWebhookSyncErrorEntry({
          payloadHubspot: auditTrail.payload_Hubspot,
          payloadSap: auditTrail.payload_SAP,
          responseHubspot: auditTrail.response_hubspot,
          responseSap: {
            ...auditTrail.response_SAP,
            error: this.buildErrorResponseSnapshot(error),
          },
        }),
      ];

      throw error;
    }
  }
}

export default ProcessHubspotCreateQuotation;
