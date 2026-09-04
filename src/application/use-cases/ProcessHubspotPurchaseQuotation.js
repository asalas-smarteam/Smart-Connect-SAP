import {
  PURCHASE_QUOTATION_BASE_TYPE,
  buildPurchaseQuotationPayload,
  mapPurchaseQuotationLines,
} from '#domain/purchases/purchase-quotation-builder.service.js';
import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import { resolveEventPayload } from '../services/webhook-payload.service.js';
import {
  buildSapDocumentLinkLines,
  createDocumentAuditTrail,
  mergeHubspotResponses,
  resolveDocumentSlpCode,
} from './webhookQuotationSupport.js';
import { createNoopSapCallRecorder } from '../services/sap-call-audit.service.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';

// Purchase Quotation (OPQT). Shorter than its sales siblings on purpose: it has NO Business
// Partner step. A purchasing document needs a supplier CardCode, and the shared
// resolveBusinessPartnerForDocument path creates customers (CardType 'C'), so running it here
// would create a customer BP for a purchase. The supplier code comes from a FieldMapping
// instead — see purchase-quotation-builder.service.js for the full design rule. That also means
// this flow never syncs company/contact back to HubSpot: the only write-back is DocEntry/DocNum
// on the deal.
export class ProcessHubspotPurchaseQuotation {
  constructor({
    runtimeRepository,
    sapPurchaseQuotationAdapter,
    hubspotWebhookAdapter,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    createSapCallRecorder = createNoopSapCallRecorder,
    logger = { warn: () => {} },
  }) {
    this.createSapCallRecorder = createSapCallRecorder;
    this.runtimeRepository = runtimeRepository;
    this.sapPurchaseQuotationAdapter = sapPurchaseQuotationAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSapAudit = buildWebhookSapAudit;
    this.logger = logger;
  }

  async execute({ event, tenantModels, tenantId, tenantKey, portalId }) {
    const { payload, deal, lineItems } = resolveEventPayload(event);
    const SapDocumentLink = tenantModels?.SapDocumentLink;
    const dealId = toNonEmptyString(deal?.hs_object_id);
    const sapCallRecorder = this.createSapCallRecorder();
    const auditTrail = createDocumentAuditTrail(
      payload,
      'purchaseQuotation',
      sapCallRecorder.calls
    );
    const sapPurchaseQuotationAdapter = sapCallRecorder.wrap(this.sapPurchaseQuotationAdapter);
    let purchaseQuotationResponse = null;
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

      const { mappings, sapConfig, hubspotCredentials } = context;

      // Idempotency: do not create a second Purchase Quotation for the same deal.
      const existingLink = await this.sapDocumentLinkRepository.findByDeal({
        SapDocumentLink,
        hubspotCredentialId: hubspotCredentials._id,
        dealId,
        documentType: 'purchaseQuotation',
      });

      if (existingLink) {
        this.logger.info?.({
          msg: 'Purchase Quotation already exists for deal, skipping creation',
          dealId,
          sapDocEntry: existingLink.sapDocEntry,
        });
        auditTrail.skipped = {
          reason: 'purchase_quotation_already_exists',
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

      const mappedDeal = mapHubspotToSapFields(
        deal || {},
        mappings.dealPurchaseQuotationsMappings,
        { logger: this.logger }
      );
      const documentLines = mapPurchaseQuotationLines({
        lineItems,
        lineMappings: mappings.productPurchaseQuotationsMappings,
      });
      const slpCode = await resolveDocumentSlpCode({
        runtimeRepository: this.runtimeRepository,
        tenantModels,
        deal,
        hubspotCredentials,
        logger: this.logger,
      });

      const documentDefaults = await this.runtimeRepository
        .resolvePurchaseQuotationDefaults(tenantModels);

      const purchaseQuotationPayload = buildPurchaseQuotationPayload({
        mappedDealFields: mappedDeal,
        documentDefaults,
        documentLines,
        slpCode,
      });
      cardCode = purchaseQuotationPayload.CardCode;
      auditTrail.payload_SAP.purchaseQuotation = purchaseQuotationPayload;

      purchaseQuotationResponse = await sapPurchaseQuotationAdapter.createPurchaseQuotation({
        sapConfig,
        purchaseQuotationPayload,
      });
      auditTrail.response_SAP.purchaseQuotation = purchaseQuotationResponse;

      const linkLines = buildSapDocumentLinkLines({
        lineItems,
        documentLines,
        responseLines: purchaseQuotationResponse?.DocumentLines,
      });

      await this.sapDocumentLinkRepository.create({
        SapDocumentLink,
        link: {
          portalId: toNonEmptyString(payload?.portalId || portalId),
          dealId,
          clientConfigId: hubspotCredentials.clientConfigId,
          hubspotCredentialId: hubspotCredentials._id,
          cardCode,
          documentType: 'purchaseQuotation',
          sapObject: 'PurchaseQuotations',
          sapDocEntry: purchaseQuotationResponse?.DocEntry ?? null,
          sapDocNum: purchaseQuotationResponse?.DocNum ?? null,
          sapBaseType: PURCHASE_QUOTATION_BASE_TYPE,
          status: 'created',
          lines: linkLines,
        },
      });

      // Same rule as the Inventory Transfer Request: a tenant can map DocEntry/DocNum to
      // dedicated deal properties for this document (under purchase-quotations) so the
      // write-back doesn't collide with the quotation/order sap_docentry properties. Falls back
      // to the usual deal mappings.
      const purchaseDealMappings = mappings.dealPurchaseQuotationsMappings || [];
      const writeBackMappings = purchaseDealMappings.some(
        (mapping) => mapping?.sourceField === 'DocEntry' || mapping?.sourceField === 'DocNum'
      ) ? purchaseDealMappings : mappings.dealMappings;

      // No token is passed: updateAfterSap resolves one itself. syncCompany/syncContact are off
      // because this flow resolves no Business Partner, so there is no CardCode of a HubSpot
      // company/contact to write back — the supplier came from the deal.
      const hubspotFinalResponses = await this.hubspotWebhookAdapter.updateAfterSap({
        tenantModels,
        hubspotCredentials,
        token: null,
        payload,
        dealMappings: writeBackMappings,
        orderResponse: purchaseQuotationResponse,
        cardCode,
        syncCompany: false,
        syncContact: false,
      });
      auditTrail.response_hubspot = mergeHubspotResponses(
        auditTrail.response_hubspot,
        hubspotFinalResponses
      );

      return {
        cardCode,
        docEntry: purchaseQuotationResponse?.DocEntry ?? null,
        docNum: purchaseQuotationResponse?.DocNum ?? null,
        dealId,
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
      }

      if (purchaseQuotationResponse) {
        error.sapOrderCreated = true;
        error.sapOrderResult = {
          cardCode,
          docEntry: purchaseQuotationResponse?.DocEntry ?? null,
          docNum: purchaseQuotationResponse?.DocNum ?? null,
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

export default ProcessHubspotPurchaseQuotation;
