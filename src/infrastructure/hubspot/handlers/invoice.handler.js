import * as hubspotClient from '../hubspotClient.js';
import MongooseSapDocumentLinkRepository from '#infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';
import { getUpdateDealStageConfig } from '#infrastructure/config/updateDealStage.config.js';

const DEAL_PREFIX = 'HS-DEAL-';

// BoObjectTypes.oOrders. Una factura copiada de un pedido pone este BaseType en cada linea que
// arrastra. Filtrar por el NO es opcional: los DocEntry de SAP son secuencias por objeto, asi
// que la cotizacion 500 y la orden 500 coexisten, y sin el filtro una factura copiada de una
// cotizacion haria match con una orden ajena que tenga ese DocEntry.
const ORDER_BASE_TYPE = 17;

// Códigos estables: viajan al SyncLog y quedan guardados en Mongo, así que
// renombrarlos rompe la lectura de los logs históricos.
export const SKIP_REASONS = {
  NO_DEAL_IN_NUM_AT_CARD: 'no_deal_in_num_at_card',
  ORDER_LINK_NOT_FOUND: 'order_link_not_found',
  UPDATE_DEAL_STAGE_DISABLED: 'update_deal_stage_disabled',
  NO_ORDER_BASE_ENTRY: 'no_order_base_entry',
};

const sapDocumentLinkRepository = new MongooseSapDocumentLinkRepository();

/**
 * Extracts the HubSpot deal id from a SAP invoice NumAtCard such as "HS-DEAL-61624633980".
 * Returns null when the invoice was not originated from a HubSpot deal.
 */
export function extractDealId(numAtCard) {
  const value = String(numAtCard ?? '').trim();

  if (!value.startsWith(DEAL_PREFIX)) {
    return null;
  }

  const dealId = value.slice(DEAL_PREFIX.length).trim();
  return dealId || null;
}

/**
 * Devuelve los DocEntry de las órdenes que originaron esta factura, sin repetir. Una factura
 * real repite el mismo BaseEntry en cada una de sus líneas (verificado en SBO_DISTELSA_PROD:
 * la factura 1024440 lo trae tres veces), así que deduplicar es obligatorio y no defensivo.
 */
export function extractOrderBaseEntries(documentLines) {
  const lines = Array.isArray(documentLines) ? documentLines : [];
  const baseEntries = new Set();

  for (const line of lines) {
    if (Number(line?.BaseType) !== ORDER_BASE_TYPE) {
      continue;
    }

    // `Number(null)` es 0, y 0 es entero: sin este descarte explícito una línea con
    // BaseEntry null entraría al Set como el DocEntry 0 y buscaría un link inexistente.
    const rawBaseEntry = line?.BaseEntry;
    if (rawBaseEntry === null || typeof rawBaseEntry === 'undefined' || rawBaseEntry === '') {
      continue;
    }

    const baseEntry = Number(rawBaseEntry);
    if (Number.isInteger(baseEntry)) {
      baseEntries.add(baseEntry);
    }
  }

  return Array.from(baseEntries);
}

/**
 * Reconciles a single SAP invoice against the synced orders. When the invoice's order is
 * found in SapDocumentLinks (documentType: 'order'), the related HubSpot deal is moved to the
 * configured `updateDealStage` dealstage. Invoices are never created as HubSpot objects.
 *
 * Cada salida en `skipped` viaja con su `reason`: sin eso, una corrida que no movió
 * ningún negocio es indistinguible de una que los movió todos (ver el diagnóstico del
 * 2026-08-19, donde tres causas distintas produjeron el mismo log vacío).
 */
export async function process({ token, item, clientConfig, tenantModels, logger = console }) {
  const numAtCard = item?.rawSapData?.NumAtCard ?? item?.properties?.num_at_card;
  const sapDocNum = item?.rawSapData?.DocNum ?? item?.properties?.sap_docnum ?? null;

  try {
    const dealId = extractDealId(numAtCard);

    if (!dealId) {
      // Una factura ajena a HubSpot es lo esperado, no una anomalía: se registra
      // en debug para que una corrida de cientos de facturas no llene el log.
      logger?.debug?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.NO_DEAL_IN_NUM_AT_CARD,
        numAtCard: numAtCard ?? null,
        sapDocNum,
      });
      return { status: 'skipped', reason: SKIP_REASONS.NO_DEAL_IN_NUM_AT_CARD };
    }

    const link = await sapDocumentLinkRepository.findByDeal({
      SapDocumentLink: tenantModels?.SapDocumentLink,
      hubspotCredentialId: clientConfig?.hubspotCredentialId,
      dealId,
      documentType: 'order',
    });

    if (!link) {
      // Esto sí es anómalo: la factura dice venir de un negocio de HubSpot pero
      // no hay pedido registrado por la integración.
      logger?.warn?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND,
        dealId,
        sapDocNum,
      });
      return { status: 'skipped', reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND, dealId };
    }

    const { isRequired, dealstage } = await getUpdateDealStageConfig({ tenantModels });

    if (!isRequired || !dealstage) {
      logger?.warn?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED,
        dealId,
        sapDocNum,
        isRequired,
        dealstage: dealstage ?? null,
      });
      return { status: 'skipped', reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED, dealId };
    }

    await hubspotClient.updateDeal(token, dealId, { properties: { dealstage } });

    logger?.info?.({
      msg: 'Negocio movido de etapa por su factura en SAP',
      dealId,
      dealstage,
      sapDocNum,
    });

    return { status: 'updated', dealId };
  } catch (error) {
    logger?.error?.({
      msg: 'Error procesando una factura en el sync de facturas',
      numAtCard: numAtCard ?? null,
      sapDocNum,
      error: error.message,
    });
    return {
      status: 'failed',
      dealId: extractDealId(numAtCard),
      error: error.message,
    };
  }
}

export default {
  process,
  extractDealId,
  extractOrderBaseEntries,
  SKIP_REASONS,
};
