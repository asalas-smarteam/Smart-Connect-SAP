import {
  INVENTORY_TRANSFER_REQUEST_BASE_TYPE,
  buildInventoryTransferRequestPayload,
  mapStockTransferLines,
} from '#domain/inventory/inventory-transfer-request-builder.service.js';
import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import {
  resolveDealContactEmployeeCode,
  resolveEventPayload,
} from '../services/webhook-payload.service.js';
import {
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

export class ProcessHubspotInventoryTransferRequest {
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    sapInventoryTransferRequestAdapter,
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
    this.sapInventoryTransferRequestAdapter = sapInventoryTransferRequestAdapter;
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
    const auditTrail = createDocumentAuditTrail(
      payload,
      'inventoryTransferRequest',
      sapCallRecorder.calls
    );
    const sapOrderAdapter = sapCallRecorder.wrap(this.sapOrderAdapter);
    const sapInventoryTransferRequestAdapter = sapCallRecorder
      .wrap(this.sapInventoryTransferRequestAdapter);
    let transferResponse = null;
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

      // Idempotency: do not create a second Inventory Transfer Request for the same deal.
      const existingLink = await this.sapDocumentLinkRepository.findByDeal({
        SapDocumentLink,
        hubspotCredentialId: hubspotCredentials._id,
        dealId,
        documentType: 'inventoryTransferRequest',
      });

      if (existingLink) {
        this.logger.info?.({
          msg: 'Inventory Transfer Request already exists for deal, skipping creation',
          dealId,
          sapDocEntry: existingLink.sapDocEntry,
        });
        auditTrail.skipped = {
          reason: 'inventory_transfer_request_already_exists',
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
        contactEmployeeFailures,
        hubspotToken,
        dealContactIsContactEmployee,
      } = businessPartner;

      const mappedDeal = mapHubspotToSapFields(deal || {}, mappings.dealInventoryTransferRequestMappings);
      const stockTransferLines = mapStockTransferLines({
        lineItems,
        lineMappings: mappings.productInventoryTransferRequestMappings,
      });
      const slpCode = await resolveDocumentSlpCode({
        runtimeRepository: this.runtimeRepository,
        tenantModels,
        deal,
        hubspotCredentials,
        logger: this.logger,
      });

      const inventoryTransferRequestPayload = buildInventoryTransferRequestPayload({
        mappedDealFields: mappedDeal,
        stockTransferLines,
        cardCode,
        slpCode,
      });
      auditTrail.payload_SAP.inventoryTransferRequest = inventoryTransferRequestPayload;

      transferResponse = await sapInventoryTransferRequestAdapter.createInventoryTransferRequest({
        sapConfig,
        inventoryTransferRequestPayload,
      });
      auditTrail.response_SAP.inventoryTransferRequest = transferResponse;

      const linkLines = buildSapDocumentLinkLines({
        lineItems,
        documentLines: stockTransferLines,
        responseLines: transferResponse?.StockTransferLines,
      });

      await this.sapDocumentLinkRepository.create({
        SapDocumentLink,
        link: {
          portalId: toNonEmptyString(payload?.portalId || portalId),
          dealId,
          clientConfigId: hubspotCredentials.clientConfigId,
          hubspotCredentialId: hubspotCredentials._id,
          cardCode,
          documentType: 'inventoryTransferRequest',
          sapObject: 'InventoryTransferRequests',
          sapDocEntry: transferResponse?.DocEntry ?? null,
          sapDocNum: transferResponse?.DocNum ?? null,
          sapBaseType: INVENTORY_TRANSFER_REQUEST_BASE_TYPE,
          status: 'created',
          lines: linkLines,
        },
      });

      // A tenant can map DocEntry/DocNum to dedicated deal properties for this document
      // (under inventory-transfer-request) so the write-back doesn't collide with the
      // quotation/order sap_docentry properties. Falls back to the usual deal mappings.
      const itrDealMappings = mappings.dealInventoryTransferRequestMappings || [];
      const writeBackMappings = itrDealMappings.some(
        (mapping) => mapping?.sourceField === 'DocEntry' || mapping?.sourceField === 'DocNum'
      ) ? itrDealMappings : mappings.dealMappings;

      const hubspotFinalResponses = await this.hubspotWebhookAdapter.updateAfterSap({
        tenantModels,
        hubspotCredentials,
        token: hubspotToken,
        payload,
        dealMappings: writeBackMappings,
        orderResponse: transferResponse,
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
        docEntry: transferResponse?.DocEntry ?? null,
        docNum: transferResponse?.DocNum ?? null,
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

      if (transferResponse) {
        error.sapOrderCreated = true;
        error.sapOrderResult = {
          cardCode,
          docEntry: transferResponse?.DocEntry ?? null,
          docNum: transferResponse?.DocNum ?? null,
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

export default ProcessHubspotInventoryTransferRequest;
