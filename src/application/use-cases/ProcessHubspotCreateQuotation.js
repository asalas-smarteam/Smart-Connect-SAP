import {
  buildQuotationPayload,
  mapDocumentLines,
} from '#domain/orders/order-builder.service.js';
import { resolveEventPayload } from '../services/webhook-payload.service.js';
import {
  buildDealNumAtCard,
  buildSapDocumentLinkLines,
  createDocumentAuditTrail,
  mergeHubspotResponses,
  resolveBusinessPartnerForDocument,
  resolveDocumentSlpCode,
} from './webhookQuotationSupport.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';

export class ProcessHubspotCreateQuotation {
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    sapQuotationAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.sapQuotationAdapter = sapQuotationAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.logger = logger;
  }

  async execute({ event, tenantModels, tenantId, tenantKey, portalId }) {
    const { payload, deal, company, contact, lineItems } = resolveEventPayload(event);
    const WebhookEvent = tenantModels?.WebhookEvent;
    const SapDocumentLink = tenantModels?.SapDocumentLink;
    const companyExists = Boolean(company);
    const contactExists = Boolean(contact);
    const dealId = toNonEmptyString(deal?.hs_object_id);
    const auditTrail = createDocumentAuditTrail(payload, 'quotation');
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

      const { mappings, sapConfig, hubspotCredentials, taxCodes, miscPriceCalculationConfig } = context;

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
        return {
          cardCode: existingLink.cardCode,
          docEntry: existingLink.sapDocEntry,
          docNum: existingLink.sapDocNum,
          dealId,
        };
      }

      const businessPartner = await resolveBusinessPartnerForDocument({
        sapOrderAdapter: this.sapOrderAdapter,
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
        context,
        auditTrail,
      });
      cardCode = businessPartner.cardCode;
      const { contactEmployeeResult, hubspotToken } = businessPartner;

      const documentLines = mapDocumentLines({
        lineItems,
        productMappings: mappings.productMappings,
        taxCodes,
        miscPriceCalculationConfig,
        logger: this.logger,
      });
      const slpCode = await resolveDocumentSlpCode({
        runtimeRepository: this.runtimeRepository,
        tenantModels,
        deal,
        hubspotCredentials,
        logger: this.logger,
      });
      const quotationPayload = buildQuotationPayload({
        cardCode,
        documentLines,
        slpCode,
        numAtCard: buildDealNumAtCard(dealId),
        comments: 'Oferta creada desde HubSpot',
      });
      auditTrail.payload_SAP.quotation = quotationPayload;

      quotationResponse = await this.sapQuotationAdapter.createQuotation({
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
        contactEmployeeCode: contactEmployeeResult.internalCode,
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
      };
    } catch (error) {
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
