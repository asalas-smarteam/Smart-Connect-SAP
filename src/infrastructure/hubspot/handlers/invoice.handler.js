import * as hubspotClient from '../hubspotClient.js';
import MongooseSapDocumentLinkRepository from '#infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';
import { getUpdateDealStageConfig } from '#infrastructure/config/updateDealStage.config.js';

const DEAL_PREFIX = 'HS-DEAL-';

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
 */
export async function process({ token, item, clientConfig, tenantModels }) {
  try {
    const numAtCard = item?.rawSapData?.NumAtCard ?? item?.properties?.num_at_card;
    const dealId = extractDealId(numAtCard);

    if (!dealId) {
      return { status: 'skipped' };
    }

    const link = await sapDocumentLinkRepository.findByDeal({
      SapDocumentLink: tenantModels?.SapDocumentLink,
      hubspotCredentialId: clientConfig?.hubspotCredentialId,
      dealId,
      documentType: 'order',
    });

    if (!link) {
      return { status: 'skipped' };
    }

    const { isRequired, dealstage } = await getUpdateDealStageConfig({ tenantModels });

    if (!isRequired || !dealstage) {
      return { status: 'skipped' };
    }

    await hubspotClient.updateDeal(token, dealId, { properties: { dealstage } });

    return { status: 'updated', dealId };
  } catch (error) {
    console.error('invoice.handler process error:', error);
    return { status: 'failed' };
  }
}

export default {
  process,
  extractDealId,
};
