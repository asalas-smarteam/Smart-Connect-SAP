import { buildOrderFromQuotationPayload } from '#domain/orders/order-builder.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { resolveEventPayload } from '../services/webhook-payload.service.js';
import {
  buildDealNumAtCard,
  createDocumentAuditTrail,
  mergeHubspotResponses,
  resolveDocumentSlpCode,
} from './webhookQuotationSupport.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';

export class ProcessHubspotConvertQuotationToOrder {
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    hubspotWebhookAdapter,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.logger = logger;
  }

  async execute({ event, tenantModels, tenantId, tenantKey, portalId }) {
    const { payload, deal } = resolveEventPayload(event);
    const SapDocumentLink = tenantModels?.SapDocumentLink;
    const dealId = toNonEmptyString(deal?.hs_object_id);
    const auditTrail = createDocumentAuditTrail(payload, 'order');
    let orderResponse = null;
    let cardCode = null;

    try {
      const context = await this.runtimeRepository.resolveRuntimeContext({
        tenantModels,
        payload,
        tenantId,
        tenantKey,
        portalId,
      });
      const { mappings, sapConfig, hubspotCredentials } = context;

      const quotationLink = await this.sapDocumentLinkRepository.findByDeal({
        SapDocumentLink,
        hubspotCredentialId: hubspotCredentials._id,
        dealId,
        documentType: 'quotation',
      });

      if (!quotationLink?.sapDocEntry && quotationLink?.sapDocEntry !== 0) {
        throw new PermanentWebhookError(
          `No SAP quotation found for deal ${dealId} to convert into an order`
        );
      }

      cardCode = quotationLink.cardCode;

      // Idempotency: do not create a second order for the same deal.
      const existingOrderLink = await this.sapDocumentLinkRepository.findByDeal({
        SapDocumentLink,
        hubspotCredentialId: hubspotCredentials._id,
        dealId,
        documentType: 'order',
      });

      if (existingOrderLink) {
        this.logger.info?.({
          msg: 'Order already exists for deal, skipping quotation conversion',
          dealId,
          sapDocEntry: existingOrderLink.sapDocEntry,
        });
        return {
          cardCode: existingOrderLink.cardCode,
          docEntry: existingOrderLink.sapDocEntry,
          docNum: existingOrderLink.sapDocNum,
          dealId,
        };
      }

      const slpCode = await resolveDocumentSlpCode({
        runtimeRepository: this.runtimeRepository,
        tenantModels,
        deal,
        hubspotCredentials,
        logger: this.logger,
      });

      const orderPayload = buildOrderFromQuotationPayload({
        cardCode,
        baseEntry: quotationLink.sapDocEntry,
        baseLines: quotationLink.lines,
        slpCode,
        numAtCard: buildDealNumAtCard(dealId),
        comments: 'Pedido creado desde oferta SAP por etapa Orden de Compra en HubSpot',
      });
      auditTrail.payload_SAP.order = orderPayload;

      orderResponse = await this.sapOrderAdapter.createOrder({
        sapConfig,
        orderPayload,
      });
      auditTrail.response_SAP.order = orderResponse;

      await this.sapDocumentLinkRepository.create({
        SapDocumentLink,
        link: {
          portalId: toNonEmptyString(payload?.portalId || portalId),
          dealId,
          clientConfigId: hubspotCredentials.clientConfigId,
          hubspotCredentialId: hubspotCredentials._id,
          cardCode,
          documentType: 'order',
          sapObject: 'Orders',
          sapDocEntry: orderResponse?.DocEntry ?? null,
          sapDocNum: orderResponse?.DocNum ?? null,
          status: 'created',
          baseDocument: {
            documentType: 'quotation',
            sapObject: 'Quotations',
            sapDocEntry: quotationLink.sapDocEntry,
            sapDocNum: quotationLink.sapDocNum,
            sapBaseType: 23,
          },
        },
      });

      const hubspotFinalResponses = await this.hubspotWebhookAdapter.updateAfterSap({
        tenantModels,
        hubspotCredentials,
        token: null,
        payload,
        dealMappings: mappings.dealMappings,
        orderResponse,
        cardCode,
        syncCompany: false,
        syncContact: false,
        contactEmployeeCode: null,
      });
      auditTrail.response_hubspot = mergeHubspotResponses(
        auditTrail.response_hubspot,
        hubspotFinalResponses
      );

      return {
        cardCode,
        docEntry: orderResponse?.DocEntry ?? null,
        docNum: orderResponse?.DocNum ?? null,
        dealId,
      };
    } catch (error) {
      if (orderResponse) {
        error.sapOrderCreated = true;
        error.sapOrderResult = {
          cardCode,
          docEntry: orderResponse?.DocEntry ?? null,
          docNum: orderResponse?.DocNum ?? null,
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

export default ProcessHubspotConvertQuotationToOrder;
