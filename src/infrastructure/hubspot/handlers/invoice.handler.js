import * as hubspotClient from '../hubspotClient.js';
import MongooseSapDocumentLinkRepository from '#infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';
import { getUpdateDealStageConfig } from '#infrastructure/config/updateDealStage.config.js';

const DEAL_PREFIX = 'HS-DEAL-';

// Códigos estables: viajan al SyncLog y quedan guardados en Mongo, así que
// renombrarlos rompe la lectura de los logs históricos.
export const SKIP_REASONS = {
  NO_DEAL_IN_NUM_AT_CARD: 'no_deal_in_num_at_card',
  ORDER_LINK_NOT_FOUND: 'order_link_not_found',
  UPDATE_DEAL_STAGE_DISABLED: 'update_deal_stage_disabled',
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
  SKIP_REASONS,
};
