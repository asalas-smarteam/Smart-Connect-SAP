import {
  buildQuotationLineUpdates,
  IMMUTABLE_ON_PATCH_FIELDS,
  mapHubspotToSapFields,
  pickMappedHeaderFields,
} from '#domain/orders/order-builder.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { createNoopSapCallRecorder } from '../services/sap-call-audit.service.js';
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
    buildWebhookSapAudit,
    createSapCallRecorder = createNoopSapCallRecorder,
    logger = { warn: () => {} },
  }) {
    this.createSapCallRecorder = createSapCallRecorder;
    this.runtimeRepository = runtimeRepository;
    this.sapQuotationAdapter = sapQuotationAdapter;
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
    const auditTrail = createDocumentAuditTrail(payload, 'quotation', sapCallRecorder.calls);
    const sapQuotationAdapter = sapCallRecorder.wrap(this.sapQuotationAdapter);

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
      await sapQuotationAdapter.getQuotation({
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

      const mappedDeal = mapHubspotToSapFields(
        deal || {},
        mappings.dealOrdersQuotationsMappings,
        { logger: this.logger }
      );

      // El PATCH solo lleva lo que el workflow mando en ESTE evento: mapHubspotToSapFields no
      // produce clave para una propiedad ausente o vacia. Asi, editar lineas en HubSpot no pisa
      // los campos de cabecera que un usuario haya corregido a mano en SAP.
      //
      // Tres campos quedan afuera del PATCH aunque el tenant los tenga mapeados, por tres motivos
      // distintos:
      // - DocDueDate (via RESERVED_HEADER_FIELDS): lo resuelve resolveDocDueDate en los builders.
      //   Mover el vencimiento de un documento ya creado es una decision distinta de sincronizar
      //   sus lineas, y ningun tenant que usa este flujo lo mapea hoy.
      // - PaymentGroupCode (via RESERVED_HEADER_FIELDS): este caso de uso no llama a
      //   resolvePaymentGroupCode (solo los flujos de creacion lo hacen), asi que aunque el tenant
      //   lo mapee, la condicion de pago que HubSpot tenga hoy nunca llega a esta oferta: si el
      //   usuario la cambia en HubSpot, SAP conserva la vieja indefinidamente.
      // - Series/DocNum/DocDate/TaxDate/DocType/DocEntry (via IMMUTABLE_ON_PATCH_FIELDS): son
      //   identidad o fechas de creacion de un documento que en este flujo YA existe en SAP.
      //   Mandarlos en un PATCH arriesga que Service Layer rechace el PATCH completo, con lo que
      //   la sincronizacion de lineas tampoco aterriza.
      //
      // El ancla de DocumentSpecialLines usa link.lines.length (lineas del documento tal como la
      // integracion las conoce), no lineUpdates.length: buildQuotationLineUpdates solo emite una
      // entrada por line item del EVENTO que hizo match, no por linea del documento en SAP. Con
      // lineUpdates.length, editar una sola linea de una oferta de 5 reancla el texto detras de la
      // linea 0 en vez de detras de la ultima, y SAP lo acepta sin error.
      const documentLineCount = Array.isArray(link.lines) ? link.lines.length : 0;
      const mappedHeaderFields = pickMappedHeaderFields(mappedDeal, { documentLineCount });
      for (const field of IMMUTABLE_ON_PATCH_FIELDS) {
        delete mappedHeaderFields[field];
      }

      const patchPayload = {
        ...mappedHeaderFields,
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

      const quotationResponse = await sapQuotationAdapter.updateQuotation({
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
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
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

export default ProcessHubspotUpdateQuotation;
