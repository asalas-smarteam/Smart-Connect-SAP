import { buildQuotationLineUpdates } from '#domain/orders/order-builder.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { resolveEventPayload } from '../services/webhook-payload.service.js';
import { createDocumentAuditTrail, resolveDocumentSlpCode } from './webhookQuotationSupport.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

function applyLineUpdatesToLink(linkLines, lineUpdates) {
  const updatesByLineNum = new Map();
  for (const update of Array.isArray(lineUpdates) ? lineUpdates : []) {
    updatesByLineNum.set(update.LineNum, update);
  }

  return (Array.isArray(linkLines) ? linkLines : []).map((line) => {
    const update = updatesByLineNum.get(line.sapLineNum);
    if (!update) {
      return line;
    }

    return {
      ...line,
      quantity: Number.isFinite(normalizeNumber(update.Quantity, null))
        ? update.Quantity
        : line.quantity,
      unitPrice: Number.isFinite(normalizeNumber(update.UnitPrice, null))
        ? update.UnitPrice
        : line.unitPrice,
      warehouseCode: toNonEmptyString(update.WarehouseCode) || line.warehouseCode,
    };
  });
}

export class ProcessHubspotUpdateQuotation {
  constructor({
    runtimeRepository,
    sapQuotationAdapter,
    sapDocumentLinkRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapQuotationAdapter = sapQuotationAdapter;
    this.sapDocumentLinkRepository = sapDocumentLinkRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.logger = logger;
  }

  async execute({ event, tenantModels, tenantId, tenantKey, portalId }) {
    const { payload, deal, lineItems } = resolveEventPayload(event);
    const SapDocumentLink = tenantModels?.SapDocumentLink;
    const dealId = toNonEmptyString(deal?.hs_object_id);
    const auditTrail = createDocumentAuditTrail(payload, 'quotation');

    try {
      const context = await this.runtimeRepository.resolveRuntimeContext({
        tenantModels,
        payload,
        tenantId,
        tenantKey,
        portalId,
      });
      const { mappings, sapConfig, hubspotCredentials, taxCodes, miscPriceCalculationConfig, discountConfig } = context;

      const link = await this.sapDocumentLinkRepository.findByDeal({
        SapDocumentLink,
        hubspotCredentialId: hubspotCredentials._id,
        dealId,
        documentType: 'quotation',
      });

      if (!link?.sapDocEntry && link?.sapDocEntry !== 0) {
        throw new PermanentWebhookError(
          `No SAP quotation found for deal ${dealId} to update`
        );
      }

      // Validate current quotation lines exist before patching.
      await this.sapQuotationAdapter.getQuotation({
        sapConfig,
        docEntry: link.sapDocEntry,
      });

      const lineUpdates = buildQuotationLineUpdates({
        lineItems,
        productMappings: mappings.productMappings,
        linkLines: link.lines,
        taxCodes,
        miscPriceCalculationConfig,
        discountConfig,
        logger: this.logger,
      });

      const patchPayload = {
        Comments: 'Oferta actualizada por contrapropuesta desde HubSpot',
        DocumentLines: lineUpdates,
      };

      // Re-map the deal owner to its SAP salesperson in case it changed in HubSpot.
      const slpCode = await resolveDocumentSlpCode({
        runtimeRepository: this.runtimeRepository,
        tenantModels,
        deal,
        hubspotCredentials,
        logger: this.logger,
      });
      if (Number.isInteger(slpCode)) {
        patchPayload.SalesPersonCode = slpCode;
      }

      auditTrail.payload_SAP.quotation = patchPayload;

      const quotationResponse = await this.sapQuotationAdapter.updateQuotation({
        sapConfig,
        docEntry: link.sapDocEntry,
        patchPayload,
      });
      auditTrail.response_SAP.quotation = quotationResponse ?? { updated: true };

      await this.sapDocumentLinkRepository.updateLines({
        SapDocumentLink,
        id: link._id,
        lines: applyLineUpdatesToLink(link.lines, lineUpdates),
      });

      return {
        cardCode: link.cardCode,
        docEntry: link.sapDocEntry,
        docNum: link.sapDocNum,
        dealId,
      };
    } catch (error) {
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

export default ProcessHubspotUpdateQuotation;
