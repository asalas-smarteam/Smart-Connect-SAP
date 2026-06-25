import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import { resolveHubspotSapId } from '../services/webhook-payload.service.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

export function createDocumentAuditTrail(payload, documentKey) {
  return {
    payload_Hubspot: payload,
    payload_SAP: {
      businessPartner: null,
      contactEmployee: null,
      [documentKey]: null,
    },
    response_hubspot: null,
    response_SAP: {
      businessPartner: null,
      contactEmployee: null,
      [documentKey]: null,
    },
  };
}

export function resolveBusinessPartnerSyncPlan({
  businessPartnerResult,
  company,
  contact,
  companyExists,
  contactExists,
}) {
  const companyHasSapId = Boolean(resolveHubspotSapId(company));
  const contactHasSapId = Boolean(resolveHubspotSapId(contact));
  const matchedByExistingSearch = Boolean(
    businessPartnerResult.matchedBy && businessPartnerResult.matchedBy !== 'cardCode'
  );
  const shouldSyncCompanySapId = companyExists && (
    businessPartnerResult.created
    || (matchedByExistingSearch && !companyHasSapId)
  );
  const shouldSyncContactSapId = contactExists && (
    businessPartnerResult.created
    || (matchedByExistingSearch && !contactHasSapId)
  );

  return {
    shouldSyncCompanySapId,
    shouldSyncContactSapId,
    shouldSyncBusinessPartnerIds: shouldSyncCompanySapId || shouldSyncContactSapId,
  };
}

export function mergeHubspotResponses(current, next) {
  return {
    deal: next?.deal ?? current?.deal ?? null,
    company: next?.company ?? current?.company ?? null,
    contact: next?.contact ?? current?.contact ?? null,
  };
}

export async function resolveDocumentSlpCode({
  runtimeRepository,
  tenantModels,
  deal,
  hubspotCredentials,
  logger,
}) {
  const hubspotOwnerId = toNonEmptyString(deal?.hubspotOwnerId);
  const dealId = toNonEmptyString(deal?.hs_object_id);

  if (!hubspotOwnerId) {
    logger?.warn?.({
      msg: 'SAP owner not resolved because HubSpot deal owner is missing',
      dealId,
    });
    return null;
  }

  const mapping = await runtimeRepository.findOwnerMappingByHubspotOwner({
    tenantModels,
    hubspotCredentialId: hubspotCredentials?._id,
    hubspotOwnerId,
  });
  const sapOwnerId = toNonEmptyString(mapping?.sapOwnerId);

  if (!sapOwnerId) {
    logger?.warn?.({
      msg: 'SAP owner mapping not found for HubSpot owner',
      hubspotOwnerId,
      dealId,
    });
    return null;
  }

  const slpCode = Number(sapOwnerId);
  if (!Number.isInteger(slpCode)) {
    logger?.warn?.({
      msg: 'SAP owner mapping has invalid sapOwnerId',
      hubspotOwnerId,
      sapOwnerId,
      dealId,
    });
    return null;
  }

  return slpCode;
}

// Mirrors the Business Partner resolution + HubSpot id sync + contact employee steps of
// the existing createDeal flow, so the quotation flow can reuse it without duplicating code.
export async function resolveBusinessPartnerForDocument({
  sapOrderAdapter,
  hubspotWebhookAdapter,
  runtimeRepository,
  webhookReferenceRepository,
  WebhookEvent,
  eventId,
  payload,
  company,
  contact,
  companyExists,
  contactExists,
  context,
  auditTrail,
}) {
  const { mappings, sapConfig, hubspotCredentials } = context;
  const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings);
  const mappedContact = mapHubspotToSapFields(contact || {}, mappings.contactBusinessPartnerMappings);

  const businessPartnerResult = await sapOrderAdapter.findOrCreateBusinessPartner({
    sapConfig,
    tenantModels: context.tenantModels,
    company,
    contact,
    mappedCompany,
    mappedContact,
    companyExists: companyExists || !contactExists,
    resolveDefaultPriceListNum: (models) => runtimeRepository.resolveDefaultPriceListNum(models),
    resolveRequireRandCardCode: (models) => runtimeRepository.resolveRequireRandCardCode(models),
    resolveDefaultSeries: (models) => runtimeRepository.resolveDefaultSeries(models),
    resolveDefaultFindSAP: (models) => runtimeRepository.resolveDefaultFindSAP(models),
  });

  auditTrail.payload_SAP.businessPartner = businessPartnerResult.requestPayload;
  auditTrail.response_SAP.businessPartner = businessPartnerResult.responsePayload;

  const cardCode = businessPartnerResult.cardCode;
  const syncPlan = resolveBusinessPartnerSyncPlan({
    businessPartnerResult,
    company,
    contact,
    companyExists,
    contactExists,
  });

  let hubspotToken = null;
  let contactEmployeeResult = {
    created: false,
    internalCode: null,
    requestPayload: null,
    responsePayload: null,
  };

  if (syncPlan.shouldSyncBusinessPartnerIds) {
    hubspotToken = await hubspotWebhookAdapter.getAccessToken({
      tenantModels: context.tenantModels,
      hubspotCredentials,
    });
    auditTrail.response_hubspot = await hubspotWebhookAdapter.updateBusinessPartnerIds({
      token: hubspotToken,
      payload,
      cardCode,
      syncCompany: syncPlan.shouldSyncCompanySapId,
      syncContact: syncPlan.shouldSyncContactSapId,
    });
  }

  if (businessPartnerResult.created) {
    await webhookReferenceRepository.persistReferences({
      WebhookEvent,
      eventId,
      payload,
      companyExists,
      contactExists,
      cardCode,
    });
  }

  if (companyExists && contactExists) {
    contactEmployeeResult = await sapOrderAdapter.addContactEmployeeIfNeeded({
      sapConfig,
      cardCode,
      businessPartner: businessPartnerResult.businessPartner,
      contact,
      contactEmployeeMappings: mappings.contactEmployeeMappings,
    });

    if (contactEmployeeResult.internalCode) {
      await webhookReferenceRepository.persistReferences({
        WebhookEvent,
        eventId,
        payload,
        companyExists,
        contactExists,
        contactEmployeeCode: contactEmployeeResult.internalCode,
      });
    }
  }

  auditTrail.payload_SAP.contactEmployee = contactEmployeeResult.requestPayload;
  auditTrail.response_SAP.contactEmployee = contactEmployeeResult.responsePayload;

  return {
    cardCode,
    businessPartnerResult,
    contactEmployeeResult,
    hubspotToken,
  };
}

// Maps each created SAP line back to its originating HubSpot line item by position so the
// hubspotLineItemId -> sapLineNum relation can be persisted for later update/convert flows.
export function buildSapDocumentLinkLines({ lineItems, documentLines, responseLines }) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const docLines = Array.isArray(documentLines) ? documentLines : [];
  const respLines = Array.isArray(responseLines) ? responseLines : [];

  return items.map((lineItem, index) => {
    const docLine = docLines[index] || {};
    const respLine = respLines[index] || {};
    const sapLineNum = normalizeNumber(respLine?.LineNum, index);

    return {
      hubspotLineItemId: toNonEmptyString(lineItem?.hubspot_id) || null,
      hubspotProductId: toNonEmptyString(lineItem?.hs_product_id) || null,
      sku: toNonEmptyString(docLine?.ItemCode || lineItem?.hs_sku) || null,
      sapLineNum: Number.isFinite(sapLineNum) ? sapLineNum : index,
      quantity: normalizeNumber(docLine?.Quantity ?? lineItem?.quantity, null),
      unitPrice: normalizeNumber(docLine?.UnitPrice, null),
      warehouseCode: toNonEmptyString(docLine?.WarehouseCode || lineItem?.warehouses) || null,
    };
  });
}

export function buildDealNumAtCard(dealId) {
  const normalized = toNonEmptyString(dealId);
  return normalized ? `HS-DEAL-${normalized}` : null;
}
