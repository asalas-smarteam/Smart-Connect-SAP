import * as hubspotClient from '../hubspotClient.js';
import MongooseSapDocumentLinkRepository from '#infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';
import { getUpdateDealStageConfig } from '#infrastructure/config/updateDealStage.config.js';

// BoObjectTypes.oOrders. Una factura copiada de un pedido pone este BaseType en cada linea que
// arrastra. Filtrar por el NO es opcional: los DocEntry de SAP son secuencias por objeto, asi
// que la cotizacion 500 y la orden 500 coexisten, y sin el filtro una factura copiada de una
// cotizacion haria match con una orden ajena que tenga ese DocEntry.
const ORDER_BASE_TYPE = 17;

// Códigos estables: viajan al SyncLog y quedan guardados en Mongo, así que
// renombrarlos rompe la lectura de los logs históricos.
export const SKIP_REASONS = {
  // Histórico: lo emitía la reconciliación por prefijo HS-DEAL- en NumAtCard, retirada el
  // 2026-08-19 en favor del linaje SAP. Ya no se emite, pero los SyncLog guardados en Mongo lo
  // tienen en skippedReasons y borrarlo hace ilegibles esas corridas.
  NO_DEAL_IN_NUM_AT_CARD: 'no_deal_in_num_at_card',
  ORDER_LINK_NOT_FOUND: 'order_link_not_found',
  UPDATE_DEAL_STAGE_DISABLED: 'update_deal_stage_disabled',
  NO_ORDER_BASE_ENTRY: 'no_order_base_entry',
};

const sapDocumentLinkRepository = new MongooseSapDocumentLinkRepository();

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
 * Reconcilia una factura de SAP contra las órdenes sincronizadas. La factura trae el DocEntry de
 * su orden en DocumentLines[].BaseEntry (BaseType 17), y desde el SapDocumentLink de esa orden se
 * llega al negocio de HubSpot, que se mueve a la etapa configurada en `updateDealStage`. Las
 * facturas nunca se crean como objetos de HubSpot.
 *
 * El NumAtCard ya no decide nada: es la orden de compra del cliente y sólo viaja al log.
 *
 * Cada salida en `skipped` viaja con su `reason`: sin eso, una corrida que no movió ningún
 * negocio es indistinguible de una que los movió todos.
 */
export async function process({ token, item, clientConfig, tenantModels, logger = console }) {
  const numAtCard = item?.rawSapData?.NumAtCard ?? item?.properties?.num_at_card ?? null;
  const sapDocNum = item?.rawSapData?.DocNum ?? item?.properties?.sap_docnum ?? null;

  // Declarados afuera del try para que el catch pueda reportar, ante un fallo a mitad de
  // camino en una factura consolidada, que ordenes ya se resolvieron y que negocios ya se
  // movieron antes de que reventara.
  let baseEntries = [];
  const movedDealIds = [];

  try {
    baseEntries = extractOrderBaseEntries(item?.rawSapData?.DocumentLines);

    if (!baseEntries.length) {
      // Una factura que no nació de un pedido es lo esperado, no una anomalía.
      logger?.debug?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY,
        numAtCard,
        sapDocNum,
      });
      return { status: 'skipped', reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY };
    }

    const dealIds = [];
    for (const sapDocEntry of baseEntries) {
      const link = await sapDocumentLinkRepository.findByOrderDocEntry({
        SapDocumentLink: tenantModels?.SapDocumentLink,
        hubspotCredentialId: clientConfig?.hubspotCredentialId,
        sapDocEntry,
      });

      if (link?.dealId) {
        dealIds.push(String(link.dealId));
      }
    }

    if (!dealIds.length) {
      // Un pedido que la integración no creó: en un tenant que también factura sus propios
      // pedidos de SAP esto es la mayoría de cada corrida, así que va en debug.
      logger?.debug?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND,
        baseEntries,
        numAtCard,
        sapDocNum,
      });
      return { status: 'skipped', reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND };
    }

    const { isRequired, dealstage } = await getUpdateDealStageConfig({ tenantModels });

    if (!isRequired || !dealstage) {
      logger?.warn?.({
        msg: 'Factura descartada por el sync de facturas',
        reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED,
        dealIds,
        sapDocNum,
        isRequired,
        dealstage: dealstage ?? null,
      });
      return { status: 'skipped', reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED };
    }

    for (const dealId of dealIds) {
      await hubspotClient.updateDeal(token, dealId, { properties: { dealstage } });
      // Se registra apenas HubSpot confirma el update, no al final del loop: si un
      // dealId posterior revienta (un 429 es el caso mas probable en este repo), el
      // catch necesita saber cuales ya quedaron movidos.
      movedDealIds.push(dealId);
    }

    logger?.info?.({
      msg: 'Negocio movido de etapa por su factura en SAP',
      dealIds,
      dealstage,
      sapDocNum,
    });

    return { status: 'updated', dealId: dealIds[0], dealIds };
  } catch (error) {
    // En una factura consolidada, `movedDealIds` puede ser un subconjunto de `dealIds`:
    // el fallo llego a mitad de camino y esos negocios ya se movieron en HubSpot, asi
    // que el log tiene que decir cuales para poder resolverlo a mano.
    logger?.error?.({
      msg: 'Error procesando una factura en el sync de facturas',
      numAtCard,
      sapDocNum,
      baseEntries,
      movedDealIds,
      error: error.message,
    });
    return { status: 'failed', error: error.message, movedDealIds };
  }
}

export default {
  process,
  extractOrderBaseEntries,
  SKIP_REASONS,
};
