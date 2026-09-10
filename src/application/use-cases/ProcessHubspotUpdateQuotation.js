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

const OPEN_DOCUMENT_STATUS = 'bost_Open';

function resolveSapDocumentLines(quotation) {
  return Array.isArray(quotation?.DocumentLines) ? quotation.DocumentLines : [];
}

// El PATCH con reemplazo de coleccion no puede tocar una oferta cerrada ni una linea que ya
// alimento otro documento: SAP rechaza el PATCH COMPLETO, y el sintoma se ve como "la
// sincronizacion de lineas dejo de funcionar", no como un problema de estado del documento.
// Se valida antes para que el evento falle nombrando la causa real.
//
// Un LineStatus nulo o ausente NO se toma como cerrado: no todas las versiones del Service Layer
// lo devuelven, y fallar por su ausencia bloquearia ofertas perfectamente abiertas.
function assertQuotationIsPatchable(quotation, docEntry) {
  const documentStatus = toNonEmptyString(quotation?.DocumentStatus);
  if (documentStatus && documentStatus !== OPEN_DOCUMENT_STATUS) {
    throw new PermanentWebhookError(
      `SAP quotation ${docEntry} is not open (DocumentStatus ${documentStatus}); its lines cannot be synced`
    );
  }

  for (const line of resolveSapDocumentLines(quotation)) {
    const lineStatus = toNonEmptyString(line?.LineStatus);
    if (lineStatus && lineStatus !== OPEN_DOCUMENT_STATUS) {
      throw new PermanentWebhookError(
        `SAP quotation ${docEntry} line ${line?.LineNum} is not open (LineStatus ${lineStatus}); its lines cannot be synced`
      );
    }
  }
}

// Reconstruye `link.lines` desde el estado REAL de SAP despues del PATCH, en vez de mutar el
// array anterior. Hace falta porque ahora las lineas se agregan y se eliminan: un mutador solo
// sabe actualizar entradas existentes, y dejaria el link sin las altas y con las bajas. Eso
// importa mas alla del propio update -- buildOrderFromQuotationPayload arma las DocumentLines de
// la orden desde `link.lines`, asi que un link desincronizado crea la orden con lineas viejas.
//
// Los ids de HubSpot se recuperan cruzando por SKU, porque el GET de SAP no los conoce. Se usa una
// cola por SKU y no un Map de un solo valor: una oferta puede repetir el mismo articulo en varias
// lineas, y un Map dejaria todas apuntando al mismo line item de HubSpot.
function buildLinkLinesFromSap(sapLines, lineItems) {
  const pendingBySku = new Map();
  for (const lineItem of Array.isArray(lineItems) ? lineItems : []) {
    const sku = toNonEmptyString(lineItem?.hs_sku || lineItem?.sku || lineItem?.itemCode);
    if (!sku) {
      continue;
    }
    if (!pendingBySku.has(sku)) {
      pendingBySku.set(sku, []);
    }
    pendingBySku.get(sku).push(lineItem);
  }

  return sapLines.map((line) => {
    const sku = toNonEmptyString(line?.ItemCode);
    const lineItem = sku ? pendingBySku.get(sku)?.shift() : null;

    return {
      hubspotLineItemId: toNonEmptyString(
        lineItem?.hubspot_id || lineItem?.hs_object_id || lineItem?.hubspotLineItemId
      ),
      hubspotProductId: toNonEmptyString(lineItem?.hs_product_id || lineItem?.hubspotProductId),
      sku,
      sapLineNum: normalizeNumber(line?.LineNum, null),
      quantity: normalizeNumber(line?.Quantity, null),
      unitPrice: normalizeNumber(line?.UnitPrice, null),
      warehouseCode: toNonEmptyString(line?.WarehouseCode),
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

      // La respuesta de este GET SI se usa (antes se descartaba y solo servia para comprobar que
      // el documento existia). Aporta tres cosas que el PATCH con reemplazo de coleccion necesita:
      // el estado del documento y de cada linea, los LineNum reales para calcular el proximo
      // libre, y la cantidad de lineas que ancla DocumentSpecialLines.
      const currentQuotation = await sapQuotationAdapter.getQuotation({
        sapConfig,
        docEntry: link.sapDocEntry,
      });

      assertQuotationIsPatchable(currentQuotation, link.sapDocEntry);
      const currentSapLines = resolveSapDocumentLines(currentQuotation);

      const lineUpdates = buildQuotationLineUpdates({
        lineItems,
        productMappings: mappings.productMappings,
        // Mismo contexto que usa mapDocumentLines al crear la oferta, para que un campo de linea
        // editable en HubSpot (ItemDescription, U_TEXTO_LIBRE, ...) tambien se actualice en SAP.
        lineMappings: mappings.productOrdersQuotationsMappings,
        linkLines: link.lines,
        // Los LineNum tal como los tiene SAP. Son la fuente correcta del proximo LineNum libre:
        // link.lines puede haber quedado corto por los descuadres que este cambio arregla, y con
        // un max mas bajo que el real un alta sobreescribiria una linea viva.
        documentLineNums: currentSapLines.map((line) => line?.LineNum),
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
      // El ancla de DocumentSpecialLines cuenta las lineas del DOCUMENTO, no las entradas del
      // PATCH: buildQuotationLineUpdates emite una entrada por line item del evento, no por linea
      // de la oferta. Con lineUpdates.length, editar una sola linea de una oferta de 5 reancla el
      // texto detras de la linea 0 en vez de detras de la ultima, y SAP lo acepta sin error.
      //
      // La cuenta sale del GET a SAP y no de link.lines: cuando el link quedo desincronizado por
      // los descuadres que este cambio arregla, link.lines miente y el ancla cae en el lugar
      // equivocado. Con el GET vacio se cae de vuelta a link.lines.
      const documentLineCount = currentSapLines.length
        || (Array.isArray(link.lines) ? link.lines.length : 0);
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
        // Sin esto, una linea que el asesor quito en HubSpot (y que por lo tanto no viaja en
        // DocumentLines) se queda viva en SAP: el PATCH normal conserva las filas que no vienen.
        replaceCollections: true,
      });
      auditTrail.response_SAP.quotation = quotationResponse ?? { updated: true };

      // Se relee la oferta para reconstruir link.lines desde el estado real de SAP. El PATCH
      // responde 204 sin cuerpo, asi que los LineNum de las altas no vuelven por ninguna otra via,
      // y las bajas hay que sacarlas del link para que la conversion a orden no las arrastre.
      const patchedQuotation = await sapQuotationAdapter.getQuotation({
        sapConfig,
        docEntry: link.sapDocEntry,
      });

      await this.sapDocumentLinkRepository.updateLines({
        SapDocumentLink,
        id: link._id,
        lines: buildLinkLinesFromSap(resolveSapDocumentLines(patchedQuotation), lineItems),
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
