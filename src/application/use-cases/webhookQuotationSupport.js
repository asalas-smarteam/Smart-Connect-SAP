import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import { resolveHubspotSapId } from '../services/webhook-payload.service.js';
import {
  buildContactEmployeeFailureMessage,
  recordContactEmployeeFailures,
} from '../services/contact-employee-failures.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { resolveBusinessPartnerAndContactEmployees } from '#domain/business-partners/contact-employee-source.service.js';
import { buildBpAddresses } from '#domain/business-partners/bp-addresses.service.js';
import { buildSapPropertiesFlags } from '#domain/business-partners/sap-properties-flags.service.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// `sapCalls` es el array del grabador de tráfico (lo inyecta el use case): se comparte por
// referencia para que el catch vea todas las llamadas, incluida la que falló.
export function createDocumentAuditTrail(payload, documentKey, sapCalls = []) {
  return {
    payload_Hubspot: payload,
    sapCalls,
    payload_SAP: {
      businessPartner: null,
      businessPartnerUpdate: null,
      contactEmployee: null,
      contactEmployeeUpdate: null,
      [documentKey]: null,
    },
    response_hubspot: null,
    response_SAP: {
      businessPartner: null,
      businessPartnerUpdate: null,
      contactEmployee: null,
      contactEmployeeUpdate: null,
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
  const hubspotOwnerId = toNonEmptyString(deal?.hubspot_owner_id || deal?.hubspotOwnerId);
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
  contactEmployees = [],
  bpAddress = [],
  businessPartnerPayloadStrategyFactory,
  logger = console,
  context,
  auditTrail,
}) {
  const { mappings, sapConfig, hubspotCredentials } = context;
  const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings);
  const mappedContact = mapHubspotToSapFields(contact || {}, mappings.contactBusinessPartnerMappings);
  // Resolved once per event (not a resolver-per-item like the others below) so
  // findOrCreateBusinessPartner/addContactEmployeeIfNeeded don't each trigger their own read.
  const upsertConfig = await runtimeRepository.resolveUpsertDataSap(context.tenantModels);
  const creationConfig = await runtimeRepository
    .resolveBusinessPartnerCreationConfig(context.tenantModels);
  const propertiesConfig = await runtimeRepository
    .resolvePropertiesFlagsConfig(context.tenantModels);
  const sapErrorBypass = await runtimeRepository
    .resolveSapErrorBypassConfig(context.tenantModels);

  const businessPartnerShape = resolveBusinessPartnerAndContactEmployees({
    company,
    contact,
    contactEmployees,
    source: creationConfig.contactEmployeeSource,
  });

  for (const warning of businessPartnerShape.warnings) {
    logger?.warn?.({ msg: 'BusinessPartner shape warning', ...warning });
  }

  // Cada entrada del array se mapea por separado, igual que line_items.
  const { addresses: bpAddresses, warnings: addressWarnings } = buildBpAddresses({
    mappedAddresses: bpAddress.map(
      (entry) => mapHubspotToSapFields(entry, mappings.addressMappings)
    ),
    addressesConfig: creationConfig.addresses,
    addressDefaults: creationConfig.defaults.BPAddress,
  });

  for (const warning of addressWarnings) {
    logger?.warn?.({ msg: 'BPAddresses warning', ...warning });
  }

  // Mismo orden de precedencia que BusinessPartner: el default configurado
  // gana siempre, el valor mapeado de HubSpot solo llena lo que el default
  // no cubre.
  const mappedContactEmployees = businessPartnerShape.contactEmployeeSources.map((source) => ({
    ...mapHubspotToSapFields(source, mappings.contactEmployeeMappings),
    ...creationConfig.defaults.ContactEmployee,
  }));

  const { flags: propertiesFlags, invalid: invalidProperties } = buildSapPropertiesFlags({
    hubspotValue: propertiesConfig.hubspotProperty
      ? businessPartnerShape.businessPartner?.[propertiesConfig.hubspotProperty]
      : null,
    config: propertiesConfig,
  });

  if (invalidProperties.length > 0) {
    logger?.warn?.({ msg: 'PropertiesN values ignored', invalid: invalidProperties });
  }

  const payloadStrategy = businessPartnerPayloadStrategyFactory
    .getStrategy(creationConfig.payloadStrategy);

  const businessPartnerResult = await sapOrderAdapter.findOrCreateBusinessPartner({
    sapConfig,
    tenantModels: context.tenantModels,
    company,
    contact,
    mappedCompany,
    mappedContact,
    companyExists: businessPartnerShape.isCompanyBusinessPartner,
    resolveDefaultPriceListNum: (models) => runtimeRepository.resolveDefaultPriceListNum(models),
    resolveRequireRandCardCode: (models) => runtimeRepository.resolveRequireRandCardCode(models),
    resolveDefaultSeries: (models) => runtimeRepository.resolveDefaultSeries(models),
    resolveDefaultFindSAP: (models) => runtimeRepository.resolveDefaultFindSAP(models),
    resolveGroupCodeDefaults: (models) => runtimeRepository.resolveGroupCodeDefaults(models),
    upsertConfig,
    payloadStrategy,
    bpAddresses,
    mappedContactEmployees,
    propertiesFlags,
    creationDefaults: creationConfig.defaults,
  });

  auditTrail.payload_SAP.businessPartner = businessPartnerResult.requestPayload;
  auditTrail.response_SAP.businessPartner = businessPartnerResult.responsePayload;
  auditTrail.payload_SAP.businessPartnerUpdate = businessPartnerResult.updateResult?.requestPayload ?? null;
  auditTrail.response_SAP.businessPartnerUpdate = businessPartnerResult.updateResult?.responsePayload ?? null;

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
    internalCodes: [],
    requestPayload: null,
    responsePayload: null,
    updateResults: [],
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

  // Si la strategy ya mandó los ContactEmployees anidados en el POST, un PATCH
  // posterior los duplicaría. Si el BP ya existía, se reconcilian.
  const contactEmployeesWentInCreate = businessPartnerResult.created
    && payloadStrategy.includesContactEmployeesInCreate();

  if (!contactEmployeesWentInCreate && businessPartnerShape.contactEmployeeSources.length > 0) {
    contactEmployeeResult = await sapOrderAdapter.addContactEmployeesIfNeeded({
      sapConfig,
      cardCode,
      businessPartner: businessPartnerResult.businessPartner,
      contacts: businessPartnerShape.contactEmployeeSources,
      contactEmployeeMappings: mappings.contactEmployeeMappings,
      upsertConfig,
    });
  }

  if (contactEmployeeResult.internalCodes?.length > 0) {
    await webhookReferenceRepository.persistReferences({
      WebhookEvent,
      eventId,
      payload,
      companyExists,
      contactExists,
      contactEmployeeCode: contactEmployeeResult.internalCodes[0].internalCode,
      dealContactIsContactEmployee: businessPartnerShape.dealContactIsContactEmployee,
    });
  }

  if (contactEmployeeResult.internalCodes?.length > 0) {
    const tokenForContactEmployees = hubspotToken || await hubspotWebhookAdapter.getAccessToken({
      tenantModels: context.tenantModels,
      hubspotCredentials,
    });

    auditTrail.response_hubspot_contactEmployees = await hubspotWebhookAdapter
      .updateContactEmployeeCodes({
        token: tokenForContactEmployees,
        internalCodes: contactEmployeeResult.internalCodes,
      });
  }

  auditTrail.payload_SAP.contactEmployee = contactEmployeeResult.requestPayload;
  auditTrail.response_SAP.contactEmployee = contactEmployeeResult.responsePayload;
  // addContactEmployeesIfNeeded (plural) returns updateResults as an array, one entry per
  // contact processed. Only the first contact's upsert audit record is surfaced here; the
  // plan doesn't specify richer multi-contact audit handling, and default config only ever
  // produces a single ContactEmployee, so [0] preserves today's exact behavior.
  auditTrail.payload_SAP.contactEmployeeUpdate = contactEmployeeResult.updateResults?.[0]?.requestPayload ?? null;
  auditTrail.response_SAP.contactEmployeeUpdate = contactEmployeeResult.updateResults?.[0]?.responsePayload ?? null;

  const contactEmployeeFailures = recordContactEmployeeFailures({
    contactEmployeeResult,
    auditTrail,
    logger,
    cardCode,
    dealId: toNonEmptyString(payload?.deal?.hs_object_id),
  });

  // Punto de corte: acá arriba ya se escribieron el BP, los ContactEmployees que SÍ
  // entraron y sus internalCodes de vuelta en HubSpot; el documento todavía NO existe.
  // Tirar acá es lo que hace que el negocio no se sincronice y se pueda corregir la data
  // en HubSpot. Los ContactEmployees ya creados quedan en SAP -- no hay rollback entre
  // llamadas del Service Layer -- pero el reenvío los reencuentra por email/nombre/
  // internalCode en vez de duplicarlos.
  //
  // `permanent`: un jobtitle demasiado largo no se arregla solo, reintentar 3 veces es
  // gastar viajes a SAP para llegar al mismo lugar. Así el evento queda `errored` en el
  // primer intento y `notifyWebhookFailure` deja la nota y revierte la etapa si el tenant
  // lo configuró.
  if (contactEmployeeFailures.length > 0 && !sapErrorBypass.contactEmployee) {
    throw new PermanentWebhookError(buildContactEmployeeFailureMessage(contactEmployeeFailures));
  }

  return {
    cardCode,
    businessPartnerResult,
    contactEmployeeResult,
    contactEmployeeFailures,
    hubspotToken,
    // Lo consumen los llamadores para decidir si el write-back legacy de
    // updateAfterSap puede escribirle internalcode al contact del deal.
    dealContactIsContactEmployee: businessPartnerShape.dealContactIsContactEmployee,
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
