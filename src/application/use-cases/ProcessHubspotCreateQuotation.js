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
  buildDealNumAtCard,
  buildSapDocumentLinkLines,
  createDocumentAuditTrail,
  mergeHubspotResponses,
  resolveBusinessPartnerForDocument,
  resolveDocumentSlpCode,
} from './webhookQuotationSupport.js';
import { createNoopSapCallRecorder } from '../services/sap-call-audit.service.js';
import { BusinessPartnerPayloadStrategyFactory } from '#domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import FullMappedBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
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

export class ProcessHubspotCreateQuotation {
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    sapQuotationAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    sapDocumentLinkRepository,
    businessPartnerPayloadStrategyFactory = createDefaultBusinessPartnerPayloadStrategyFactory(),
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
    const sapQuotationAdapter = sapCallRecorder.wrap(this.sapQuotationAdapter);
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

      const businessPartner = await resolveBusinessPartnerForDocument({
        sapOrderAdapter,
        hubspotWebhookAdapter: this.hubspotWebhookAdapter,
        runtimeRepository: this.runtimeRepository,
        webhookReferenceRepository: this.webhookReferenceRepository,
        WebhookEvent,
        eventId: event?._id,
        payload,
        company,
        contact,
        companyExists,
        contactExists,
        contactEmployees,
        bpAddress,
        businessPartnerPayloadStrategyFactory: this.businessPartnerPayloadStrategyFactory,
        logger: this.logger,
        context,
        auditTrail,
      });
      cardCode = businessPartner.cardCode;
      const {
        contactEmployeeResult,
        hubspotToken,
        dealContactIsContactEmployee,
      } = businessPartner;

      const documentLines = mapDocumentLines({
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
      const mappedDeal = mapHubspotToSapFields(deal || {}, mappings.dealOrdersQuotationsMappings);
      const groupCodeDefaults = await this.runtimeRepository.resolveGroupCodeDefaults(tenantModels);
      const paymentGroupCode = resolvePaymentGroupCode({ mappedDeal, groupCodeDefaults });
      const quotationPayload = buildQuotationPayload({
        cardCode,
        documentLines,
        slpCode,
        paymentGroupCode,
        mappedDealFields: mappedDeal,
        numAtCard: buildDealNumAtCard(dealId),
        comments: deal?.comments,
      });
      auditTrail.payload_SAP.quotation = quotationPayload;

      quotationResponse = await sapQuotationAdapter.createQuotation({
        sapConfig,
        quotationPayload,
      });
      auditTrail.response_SAP.quotation = quotationResponse;

      const linkLines = buildSapDocumentLinkLines({
        lineItems,
        documentLines,
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
          sapObject: 'Quotations',
          sapDocEntry: quotationResponse?.DocEntry ?? null,
          sapDocNum: quotationResponse?.DocNum ?? null,
          sapBaseType: 23,
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
