import axios from 'axios';
import https from 'https';
import logger from '../core/logger.js';
import mappingService from './mapping.service.js';
import hubspotAuthService from './hubspotAuthService.js';
import * as hubspotClient from './hubspotClient.js';
import sapSessionManager, { isSessionInvalidError } from './sapSessionManager.js';
import tenantConfigurationService from './tenantConfiguration.service.js';

import {
  buildErrorResponseSnapshot,
  buildWebhookSyncErrorEntry,
} from './syncLog.service.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const DEFAULT_BATCH_SIZE = Number(process.env.WEBHOOK_EVENT_BATCH_SIZE || 10);
const DEFAULT_MAX_RETRIES = Number(process.env.WEBHOOK_EVENT_MAX_RETRIES || 3);

class PermanentWebhookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentWebhookError';
    this.permanent = true;
  }
}

function cleanBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function resolveEventPayload(event) {
  const payload = event?.payload || {};
  return {
    payload,
    deal: payload?.deal || payload?.data?.deal || null,
    company: payload?.company || payload?.data?.company || null,
    contact: payload?.contact || payload?.data?.contact || null,
    lineItems: Array.isArray(payload?.line_items)
      ? payload.line_items
      : (Array.isArray(payload?.data?.line_items) ? payload.data.line_items : []),
  };
}

function escapeODataString(value) {
  return String(value || '').replace(/'/g, "''");
}

function pickByPath(input, path) {
  if (!path) {
    return null;
  }

  const segments = String(path)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return null;
  }

  let current = input;

  for (const segment of segments) {
    if (current === null || typeof current === 'undefined') {
      return null;
    }

    if (Array.isArray(current)) {
      current = current[0];
      if (current === null || typeof current === 'undefined') {
        return null;
      }
    }

    current = current?.[segment];
  }

  return typeof current === 'undefined' ? null : current;
}

function normalizeNumber(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function toNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizePositiveInteger(value, fallback = null) {
  const normalized = Number(String(value ?? '').trim());
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function resolveHubspotSapId(record) {
  return toNonEmptyString(record?.idsap || record?.idSap);
}

function resolvePayloadEntityTarget(payload, entityKey) {
  if (payload?.[entityKey] && typeof payload[entityKey] === 'object') {
    return {
      container: payload,
      key: entityKey,
      path: `payload.${entityKey}`,
    };
  }

  if (payload?.data?.[entityKey] && typeof payload.data[entityKey] === 'object') {
    return {
      container: payload.data,
      key: entityKey,
      path: `payload.data.${entityKey}`,
    };
  }

  return {
    container: payload,
    key: entityKey,
    path: `payload.${entityKey}`,
  };
}

function buildWebhookEventReferenceUpdates({
  payload,
  companyExists,
  contactExists,
  cardCode,
  contactEmployeeCode,
}) {
  const nextUpdates = {};
  const normalizedCardCode = toNonEmptyString(cardCode);
  const normalizedContactEmployeeCode = toNonEmptyString(contactEmployeeCode);

  if (normalizedCardCode) {
    if (companyExists) {
      const companyTarget = resolvePayloadEntityTarget(payload, 'company');
      companyTarget.container[companyTarget.key] = {
        ...(companyTarget.container[companyTarget.key] || {}),
        idsap: normalizedCardCode,
      };
      nextUpdates[`${companyTarget.path}.idsap`] = normalizedCardCode;
    } else if (contactExists) {
      const contactTarget = resolvePayloadEntityTarget(payload, 'contact');
      contactTarget.container[contactTarget.key] = {
        ...(contactTarget.container[contactTarget.key] || {}),
        idsap: normalizedCardCode,
      };
      nextUpdates[`${contactTarget.path}.idsap`] = normalizedCardCode;
    }
  }

  if (companyExists && contactExists && normalizedContactEmployeeCode) {
    const contactTarget = resolvePayloadEntityTarget(payload, 'contact');
    contactTarget.container[contactTarget.key] = {
      ...(contactTarget.container[contactTarget.key] || {}),
      internalCode: normalizedContactEmployeeCode,
    };
    nextUpdates[`${contactTarget.path}.internalCode`] = normalizedContactEmployeeCode;
  }

  return nextUpdates;
}

async function persistWebhookEventReferences({
  WebhookEvent,
  eventId,
  payload,
  companyExists,
  contactExists,
  cardCode = null,
  contactEmployeeCode = null,
}) {
  if (!WebhookEvent || !eventId || !payload) {
    return;
  }

  const updates = buildWebhookEventReferenceUpdates({
    payload,
    companyExists,
    contactExists,
    cardCode,
    contactEmployeeCode,
  });

  if (!Object.keys(updates).length) {
    return;
  }

  await WebhookEvent.updateOne(
    { _id: eventId },
    {
      $set: updates,
    }
  );
}

function buildDefaultBusinessPartnerCardCode({ company, contact, companyExists }) {
  const sourceObjectId = toNonEmptyString(
    companyExists ? company?.hs_object_id : contact?.hs_object_id
  );
  const normalizedSource = String(sourceObjectId || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const dynamicPart = (normalizedSource
    ? normalizedSource.slice(-12)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(-12);

  return `CL${dynamicPart}`.slice(0, 15);
}

function resolveContactDisplayName(contact) {
  const fullName = [
    toNonEmptyString(contact?.firstname),
    toNonEmptyString(contact?.lastname),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  return toNonEmptyString(
    fullName
    || contact?.name
    || contact?.email
    || contact?.hs_object_id
  );
}

async function resolveDefaultPriceListNum(tenantModels) {
  const value = await tenantConfigurationService.getValue(
    tenantModels,
    'priceList',
    null
  );
  const priceListNum = normalizePositiveInteger(value);

  if (!priceListNum) {
    throw new PermanentWebhookError(
      'PriceListNum is required from HubSpot mapping or tenant configuration priceList'
    );
  }

  return priceListNum;
}

function resolveHubspotPropertyNameBySapField(mappings, sapField, fallback = null) {
  const match = (Array.isArray(mappings) ? mappings : []).find(
    (mapping) => String(mapping?.sourceField || '').trim() === sapField
      && String(mapping?.targetField || '').trim()
  );

  return match ? String(match.targetField).trim() : fallback;
}

function mapHubspotToSapFields(source, mappings) {
  const mapped = {};

  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    if (mapping?.isActive === false) {
      continue;
    }

    const sourceField = String(mapping?.sourceField || '').trim();
    const targetField = String(mapping?.targetField || '').trim();
    if (!sourceField || !targetField) {
      continue;
    }

    const value = pickByPath(source, targetField);
    if (value !== null && typeof value !== 'undefined' && value !== '') {
      mapped[sourceField] = value;
    }
  }

  return mapped;
}

async function serviceLayerRequest(sapConfig, { method, path, data, params }) {
  const baseUrl = cleanBaseUrl(sapConfig?.serviceLayerBaseUrl);

  if (!baseUrl) {
    throw new Error('Missing serviceLayerBaseUrl for webhook processing');
  }

  const url = `${baseUrl}/b1s/v2${path.startsWith('/') ? path : `/${path}`}`;

  const requestWithSession = async () => {
    const { cookie } = await sapSessionManager.getSessionCookie(sapConfig);
    const response = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Cookie: cookie,
      },
      httpsAgent,
    });
    return response.data;
  };

  try {
    return await requestWithSession();
  } catch (error) {
    if (!isSessionInvalidError(error)) {
      throw error;
    }

    const tenantKey = sapSessionManager.resolveTenantKey(sapConfig);
    await sapSessionManager.invalidateSession(tenantKey);
    return requestWithSession();
  }
}

async function resolveWebhookRuntimeContext({ tenantModels, payload, tenantId, tenantKey, portalId }) {
  const { ClientConfig, HubspotCredentials, SapCredentials } = tenantModels;
  const resolvedPortalId = toNonEmptyString(payload?.portalId || portalId);
  const credentialQuery = resolvedPortalId ? { portalId: resolvedPortalId } : {};
  let hubspotCredentials = await HubspotCredentials.findOne(credentialQuery).lean();

  if (!hubspotCredentials) {
    hubspotCredentials = await HubspotCredentials.findOne({}).sort({ _id: 1 }).lean();
  }

  if (!hubspotCredentials?._id) {
    throw new Error('HubSpot credentials not found for tenant webhook processing');
  }

  const sapCredentials = await SapCredentials.findOne().lean();


  if (!sapCredentials?.serviceLayerBaseUrl) {
    throw new Error('SAP Service Layer credentials not configured for webhook processing');
  }

  const hubspotCredentialId = hubspotCredentials._id;
  const [
    companyMappings,
    contactBusinessPartnerMappings,
    contactEmployeeMappings,
    productMappings,
    dealMappings,
  ] = await Promise.all([
    mappingService.getMappingsByObjectType(hubspotCredentialId, 'company', 'businessPartner', tenantModels),
    mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'businessPartner', tenantModels),
    mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'contactEmployee', tenantModels),
    mappingService.getMappingsByObjectType(hubspotCredentialId, 'product', 'product', tenantModels),
    mappingService.getMappingsByObjectType(hubspotCredentialId, 'deal', 'businessPartner', tenantModels),
  ]);

  return {
    hubspotCredentials,
    sapConfig: {
      ...sapCredentials,
      tenantId: tenantId,
      tenantKey: tenantKey,
    },
    mappings: {
      companyMappings,
      contactBusinessPartnerMappings,
      contactEmployeeMappings,
      productMappings,
      dealMappings,
    },
  };
}

async function findBusinessPartnerByCardCode(sapConfig, cardCode) {
  if (!toNonEmptyString(cardCode)) {
    return null;
  }

  try {
    return await serviceLayerRequest(sapConfig, {
      method: 'get',
      path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
      params: {
        $select: 'CardCode,CardName,EmailAddress,PriceListNum,ContactEmployees',
      },
    });
  } catch (error) {
    if (error?.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

async function findBusinessPartnerByEmail(sapConfig, email) {
  if (!toNonEmptyString(email)) {
    return null;
  }

  const response = await serviceLayerRequest(sapConfig, {
    method: 'get',
    path: '/BusinessPartners',
    params: {
      $top: 1,
      $select: 'CardCode,CardName,EmailAddress,PriceListNum,ContactEmployees',
      $filter: `EmailAddress eq '${escapeODataString(email)}'`,
    },
  });

  return Array.isArray(response?.value) && response.value.length > 0
    ? response.value[0]
    : null;
}

async function findOrCreateBusinessPartner({
  sapConfig,
  tenantModels,
  company,
  contact,
  mappedCompany,
  mappedContact,
  companyExists,
}) {
  const mappedCardCode = toNonEmptyString(mappedCompany?.CardCode || mappedContact?.CardCode);
  const mappedEmail = toNonEmptyString(mappedCompany?.EmailAddress || mappedContact?.EmailAddress);
  const mappedPriceListNum = normalizeNumber(
    mappedCompany?.PriceListNum ?? mappedContact?.PriceListNum,
    null
  );
  const resolvedCardCode = mappedCardCode || buildDefaultBusinessPartnerCardCode({
    company,
    contact,
    companyExists,
  });
  const resolvedPriceListNum = Number.isFinite(mappedPriceListNum)
    ? mappedPriceListNum
    : await resolveDefaultPriceListNum(tenantModels);

  const byCardCode = await findBusinessPartnerByCardCode(sapConfig, mappedCardCode);
  if (byCardCode?.CardCode) {
    return {
      cardCode: byCardCode.CardCode,
      created: false,
      matchedBy: 'cardCode',
      businessPartner: byCardCode,
      requestPayload: null,
      responsePayload: {
        matchedBy: 'cardCode',
        businessPartner: byCardCode,
      },
    };
  }

  const byEmail = await findBusinessPartnerByEmail(sapConfig, mappedEmail);
  if (byEmail?.CardCode) {
    return {
      cardCode: byEmail.CardCode,
      created: false,
      matchedBy: 'email',
      businessPartner: byEmail,
      requestPayload: null,
      responsePayload: {
        matchedBy: 'email',
        businessPartner: byEmail,
      },
    };
  }

  const fallbackName = companyExists
    ? (company?.name || company?.company || company?.hs_name)
    : resolveContactDisplayName(contact);
  const cardName = toNonEmptyString(mappedCompany?.CardName || mappedContact?.CardName || fallbackName);

  if (!cardName) {
    throw new PermanentWebhookError('CardName is required to create Business Partner');
  }

  const payload = {
    CardName: cardName,
    CardType: 'C',
    CompanyPrivate: companyExists ? 'C' : 'P',
    EmailAddress: mappedEmail || "",
    Phone1: toNonEmptyString(mappedCompany?.Phone1 || mappedContact?.Phone1) || undefined,
    PriceListNum: resolvedPriceListNum,
    CardCode: resolvedCardCode,
    FederalTaxID: mappedCompany?.FederalTaxID 
  };

  const created = await serviceLayerRequest(sapConfig, {
    method: 'post',
    path: '/BusinessPartners',
    data: payload,
  });

  const cardCode = created?.CardCode || resolvedCardCode || null;
  if (!cardCode) {
    throw new Error('SAP BusinessPartner creation did not return CardCode');
  }

  const businessPartner = await findBusinessPartnerByCardCode(sapConfig, cardCode);
  return {
    cardCode,
    created: true,
    matchedBy: null,
    businessPartner,
    requestPayload: payload,
    responsePayload: created,
  };
}

function resolveContactEmployeePayload(contact, contactEmployeeMappings) {
  const mapped = mapHubspotToSapFields(contact || {}, contactEmployeeMappings);
  const name = toNonEmptyString(mapped?.Name || resolveContactDisplayName(contact));
  const email = toNonEmptyString(mapped?.E_Mail || mapped?.EmailAddress || contact?.email);

  if (!name && !email) {
    return null;
  }

  const payload = {
    ...mapped,
  };

  if (name) {
    payload.Name = name;
  }

  if (email) {
    payload.E_Mail = email;
    if (!payload.EmailAddress) {
      payload.EmailAddress = email;
    }
  }

  return payload;
}

async function addContactEmployeeIfNeeded({
  sapConfig,
  cardCode,
  businessPartner,
  contact,
  contactEmployeeMappings,
}) {
  if (!cardCode || !contact) {
    return { created: false, internalCode: null, requestPayload: null, responsePayload: null };
  }

  const nextEmployee = resolveContactEmployeePayload(contact, contactEmployeeMappings);
  if (!nextEmployee) {
    return { created: false, internalCode: null, requestPayload: null, responsePayload: null };
  }

  const currentEmployees = Array.isArray(businessPartner?.ContactEmployees)
    ? businessPartner.ContactEmployees
    : [];

  const email = toNonEmptyString(nextEmployee.E_Mail || nextEmployee.EmailAddress);
  const name = toNonEmptyString(nextEmployee.Name);
  const existing = currentEmployees.find((employee) => {
    const sameEmail = email
      && toNonEmptyString(employee?.E_Mail || employee?.EmailAddress)?.toLowerCase() === email.toLowerCase();
    const sameName = name
      && toNonEmptyString(employee?.Name)?.toLowerCase() === name.toLowerCase();
    return sameEmail || sameName;
  });

  if (existing) {
    return {
      created: false,
      internalCode: existing.InternalCode || null,
      requestPayload: null,
      responsePayload: {
        matchedExisting: true,
        employee: existing,
      },
    };
  }

  await serviceLayerRequest(sapConfig, {
    method: 'patch',
    path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
    data: {
      ContactEmployees: [...currentEmployees, nextEmployee],
    },
  });

  const refreshedBusinessPartner = await findBusinessPartnerByCardCode(sapConfig, cardCode);
  const refreshedEmployees = Array.isArray(refreshedBusinessPartner?.ContactEmployees)
    ? refreshedBusinessPartner.ContactEmployees
    : [];
  const refreshed = refreshedEmployees.find((employee) => {
    const sameEmail = email
      && toNonEmptyString(employee?.E_Mail || employee?.EmailAddress)?.toLowerCase() === email.toLowerCase();
    const sameName = name
      && toNonEmptyString(employee?.Name)?.toLowerCase() === name.toLowerCase();
    return sameEmail || sameName;
  });

  return {
    created: true,
    internalCode: refreshed?.InternalCode || null,
    requestPayload: nextEmployee,
    responsePayload: refreshed,
  };
}

function mapDocumentLines({ lineItems, productMappings }) {
  const lines = [];

  for (const lineItem of lineItems) {
    const mapped = mapHubspotToSapFields(lineItem, productMappings);
    const itemCode = toNonEmptyString(mapped?.ItemCode || lineItem?.hs_sku || lineItem?.itemCode);
    const quantity = normalizeNumber(mapped?.Quantity ?? lineItem?.quantity, 1);
    const unitPrice = normalizeNumber(
      mapped?.UnitPrice ?? mapped?.Price ?? lineItem?.price ?? lineItem?.amount,
      0
    );

    if (!itemCode) {
      throw new PermanentWebhookError('ItemCode/hs_sku is required in line_items mapping');
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PermanentWebhookError(`Invalid quantity for item ${itemCode}`);
    }

    lines.push({
      ItemCode: itemCode,
      Quantity: quantity,
      UnitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      WarehouseCode: lineItem.warehouses
    });
  }

  return lines;
}

function buildOrderPayload({ cardCode, documentLines }) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Order');
  }

  return {
    CardCode: cardCode,
    DocDueDate: new Date().toISOString().slice(0, 10),
    DocumentLines: documentLines,
  };
}

async function createOrder({ sapConfig, orderPayload }) {
  return serviceLayerRequest(sapConfig, {
    method: 'post',
    path: '/Orders',
    data: orderPayload,
  });
}

async function getHubspotWebhookAccessToken({ tenantModels, hubspotCredentials }) {
  return hubspotAuthService.getAccessToken(
    hubspotCredentials.clientConfigId,
    hubspotCredentials,
    tenantModels
  );
}

async function updateHubspotBusinessPartnerIds({
  token,
  payload,
  cardCode,
  syncCompany,
  syncContact,
}) {
  const hubspotResponses = {
    deal: null,
    company: null,
    contact: null,
  };

  const companyObjectId = toNonEmptyString(payload?.company?.hs_object_id);
  const contactObjectId = toNonEmptyString(payload?.contact?.hs_object_id);

  if (syncCompany && companyObjectId) {
    hubspotResponses.company = await hubspotClient.updateCompany(token, companyObjectId, {
      properties: {
        idsap: cardCode,
      },
    });
  }

  if (syncContact && contactObjectId) {
    hubspotResponses.contact = await hubspotClient.updateContact(token, contactObjectId, {
      properties: {
        idsap: cardCode,
      },
    });
  }

  return hubspotResponses;
}

function mergeHubspotResponses(current, next) {
  return {
    deal: next?.deal ?? current?.deal ?? null,
    company: next?.company ?? current?.company ?? null,
    contact: next?.contact ?? current?.contact ?? null,
  };
}

async function updateHubspotAfterSap({
  tenantModels,
  hubspotCredentials,
  token,
  payload,
  dealMappings,
  orderResponse,
  cardCode,
  syncCompany,
  syncContact,
  contactEmployeeCode,
}) {
  const resolvedToken = token || await getHubspotWebhookAccessToken({
    tenantModels,
    hubspotCredentials,
  });
  const hubspotResponses = {
    deal: null,
    company: null,
    contact: null,
  };

  const dealObjectId = toNonEmptyString(payload?.deal?.hs_object_id);
  const companyObjectId = toNonEmptyString(payload?.company?.hs_object_id);
  const contactObjectId = toNonEmptyString(payload?.contact?.hs_object_id);

  if (dealObjectId) {
    const docEntryProperty = resolveHubspotPropertyNameBySapField(dealMappings, 'DocEntry');
    const docNumProperty = resolveHubspotPropertyNameBySapField(dealMappings, 'DocNum');
    const dealProperties = {};

    if (docEntryProperty && orderResponse?.DocEntry !== undefined) {
      dealProperties[docEntryProperty] = String(orderResponse.DocEntry);
    }

    if (docNumProperty && orderResponse?.DocNum !== undefined) {
      dealProperties[docNumProperty] = String(orderResponse.DocNum);
    }

    if (Object.keys(dealProperties).length > 0) {
      hubspotResponses.deal = await hubspotClient.updateDeal(resolvedToken, dealObjectId, {
        properties: dealProperties,
      });
    }
  }

  if (syncCompany && companyObjectId) {
    hubspotResponses.company = await hubspotClient.updateCompany(resolvedToken, companyObjectId, {
      properties: {
        idsap: cardCode,
      },
    });
  }

  if (syncContact && contactObjectId) {
    const contactProperties = {
      idsap: cardCode,
    };

    if (contactEmployeeCode) {
      contactProperties.internalcode = String(contactEmployeeCode);
    }

    hubspotResponses.contact = await hubspotClient.updateContact(resolvedToken, contactObjectId, {
      properties: contactProperties,
    });
  }

  return hubspotResponses;
}

async function processSingleEvent({ event, tenantModels, tenantId, tenantKey, portalId }) {
  const { payload, deal, company, contact, lineItems } = resolveEventPayload(event);
  const WebhookEvent = tenantModels?.WebhookEvent;
  const companyExists = Boolean(company);
  const contactExists = Boolean(contact);
  const auditTrail = {
    payload_Hubspot: payload,
    payload_SAP: {
      businessPartner: null,
      contactEmployee: null,
      order: null,
    },
    response_hubspot: null,
    response_SAP: {
      businessPartner: null,
      contactEmployee: null,
      order: null,
    },
  };

  try {
    const context = await resolveWebhookRuntimeContext({
      tenantModels,
      payload,
      tenantId,
      tenantKey,
      portalId,
    });

    const { mappings, sapConfig, hubspotCredentials } = context;
    const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings);
    const mappedContact = mapHubspotToSapFields(contact || {}, mappings.contactBusinessPartnerMappings);
    const businessPartnerResult = await findOrCreateBusinessPartner({
      sapConfig,
      tenantModels,
      company,
      contact,
      mappedCompany,
      mappedContact,
      companyExists: companyExists || !contactExists,
    });

    auditTrail.payload_SAP.businessPartner = businessPartnerResult.requestPayload;
    auditTrail.response_SAP.businessPartner = businessPartnerResult.responsePayload;

    const cardCode = businessPartnerResult.cardCode;
    const companyHasSapId = Boolean(resolveHubspotSapId(company));
    const contactHasSapId = Boolean(resolveHubspotSapId(contact));
    const matchedByEmail = businessPartnerResult.matchedBy === 'email';
    const shouldSyncCompanySapId = companyExists && (
      businessPartnerResult.created
      || (matchedByEmail && !companyHasSapId)
    );
    const shouldSyncContactSapId = contactExists && (
      businessPartnerResult.created
      || (matchedByEmail && !contactHasSapId)
    );
    const shouldSyncBusinessPartnerIds = shouldSyncCompanySapId || shouldSyncContactSapId;
    let hubspotToken = null;
    let contactEmployeeResult = {
      created: false,
      internalCode: null,
      requestPayload: null,
      responsePayload: null,
    };

    if (shouldSyncBusinessPartnerIds) {
      hubspotToken = await getHubspotWebhookAccessToken({
        tenantModels,
        hubspotCredentials,
      });
      auditTrail.response_hubspot = await updateHubspotBusinessPartnerIds({
        token: hubspotToken,
        payload,
        cardCode,
        syncCompany: shouldSyncCompanySapId,
        syncContact: shouldSyncContactSapId,
      });
    }

    if (businessPartnerResult.created) {
      await persistWebhookEventReferences({
        WebhookEvent,
        eventId: event?._id,
        payload,
        companyExists,
        contactExists,
        cardCode,
      });
    }

    if (companyExists && contactExists) {
      contactEmployeeResult = await addContactEmployeeIfNeeded({
        sapConfig,
        cardCode,
        businessPartner: businessPartnerResult.businessPartner,
        contact,
        contactEmployeeMappings: mappings.contactEmployeeMappings,
      });
    }

    if (contactEmployeeResult.internalCode) {
      await persistWebhookEventReferences({
        WebhookEvent,
        eventId: event?._id,
        payload,
        companyExists,
        contactExists,
        contactEmployeeCode: contactEmployeeResult.internalCode,
      });
    }

    auditTrail.payload_SAP.contactEmployee = contactEmployeeResult.requestPayload;
    auditTrail.response_SAP.contactEmployee = contactEmployeeResult.responsePayload;

    const documentLines = mapDocumentLines({
      lineItems,
      productMappings: mappings.productMappings,
    });

    /*for (const line of documentLines) 
      await validateStockForItem(sapConfig, tenantModels, line.ItemCode, line.Quantity);
    */

    const orderPayload = buildOrderPayload({
      cardCode,
      documentLines,
    });
    auditTrail.payload_SAP.order = orderPayload;

    const orderResponse = await createOrder({
      sapConfig,
      orderPayload,
    });
    auditTrail.response_SAP.order = orderResponse;

    const hubspotFinalResponses = await updateHubspotAfterSap({
      tenantModels,
      hubspotCredentials,
      token: hubspotToken,
      payload,
      dealMappings: mappings.dealMappings,
      orderResponse,
      cardCode,
      syncCompany: false,
      syncContact: contactExists && contactEmployeeResult.created,
      contactEmployeeCode: contactEmployeeResult.internalCode,
    });
    auditTrail.response_hubspot = mergeHubspotResponses(
      auditTrail.response_hubspot,
      hubspotFinalResponses
    );

    return {
      cardCode,
      docEntry: orderResponse?.DocEntry ?? null,
      docNum: orderResponse?.DocNum ?? null,
      dealId: toNonEmptyString(deal?.hs_object_id),
    };
  } catch (error) {
    error.syncLogWebhookErrors = [
      buildWebhookSyncErrorEntry({
        payloadHubspot: auditTrail.payload_Hubspot,
        payloadSap: auditTrail.payload_SAP,
        responseHubspot: auditTrail.response_hubspot,
        responseSap: {
          ...auditTrail.response_SAP,
          error: buildErrorResponseSnapshot(error),
        },
      }),
    ];

    throw error;
  }
}

export async function claimEventsToProcess(WebhookEvent, batchSize = DEFAULT_BATCH_SIZE) {
  const claimed = [];
  const safeBatchSize = Math.max(1, Number(batchSize || DEFAULT_BATCH_SIZE));

  while (claimed.length < safeBatchSize) {
    // Claim oldest waiting events first so parallel workers do not process same document twice.
    // eslint-disable-next-line no-await-in-loop #$$$$$
    const event = await WebhookEvent.findOneAndUpdate(
      { status: 'waiting' },
      { $set: { status: 'Inprocess' } },
      { sort: { createdAt: 1, _id: 1 }, new: true }
    ).lean();

    if (!event) {
      break;
    }

    claimed.push(event);
  }

  return claimed;
}

const webhookProcessor = {
  async processPendingEvents({ tenantModels, tenantId, tenantKey, portalId } = {}) {
    if (!tenantModels) {
      throw new Error('Tenant models are required to process webhook events');
    }

    const { WebhookEvent } = tenantModels;
    const maxRetriesByEnv = Math.max(1, Number(process.env.WEBHOOK_EVENT_MAX_RETRIES || DEFAULT_MAX_RETRIES));
    const events = await claimEventsToProcess(WebhookEvent);

    if (!events?.length) {
      return {
        processed: 0,
        completed: 0,
        retried: 0,
        errored: 0,
        skipped: 0,
        errorDetails: [],
      };
    }

    logger.info({
      msg: 'Webhook batch processing started',
      tenantId: tenantId || null,
      tenantKey: tenantKey || null,
      portalId: portalId || null,
      batchSize: events.length,
    });

    const summary = {
      processed: events.length,
      completed: 0,
      retried: 0,
      errored: 0,
      skipped: 0,
      errorDetails: [],
    };

    for (const event of events) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await processSingleEvent({
          event,
          tenantModels,
          tenantId,
          tenantKey,
          portalId,
        });

        // eslint-disable-next-line no-await-in-loop
        await WebhookEvent.updateOne(
          { _id: event._id },
          {
            $set: {
              status: 'completed',
              lastError: null,
              'payload.sapResult': {
                docEntry: result.docEntry,
                docNum: result.docNum,
                cardCode: result.cardCode,
              },
              'payload.processedAt': new Date().toISOString(),
            },
          }
        );

        summary.completed += 1;
        logger.info({
          msg: 'Webhook event processed',
          tenantId: tenantId || null,
          tenantKey: tenantKey || null,
          eventId: String(event._id),
          status: 'completed',
          docEntry: result.docEntry,
          docNum: result.docNum,
        });
      } catch (error) {
        const currentRetries = Number(event?.retries || 0);
        const configuredMaxRetries = Math.max(
          1,
          Number(event?.maxRetries || 0) || maxRetriesByEnv
        );
        const isPermanent = Boolean(error?.permanent);
        const nextRetries = isPermanent ? configuredMaxRetries : currentRetries + 1;
        const shouldRetry = !isPermanent && nextRetries < configuredMaxRetries;
        const nextStatus = shouldRetry ? 'waiting' : 'errored';

        // eslint-disable-next-line no-await-in-loop
        await WebhookEvent.updateOne(
          { _id: event._id },
          {
            $set: {
              status: nextStatus,
              retries: nextRetries,
              lastError: error?.response?.data?.error?.message || error.message,
            },
          }
        );

        if (shouldRetry) {
          summary.retried += 1;
        } else {
          summary.errored += 1;
          if (Array.isArray(error?.syncLogWebhookErrors) && error.syncLogWebhookErrors.length > 0) {
            summary.errorDetails.push(...error.syncLogWebhookErrors);
          } else {
            summary.errorDetails.push(
              buildWebhookSyncErrorEntry({
                payloadHubspot: event?.payload || null,
                payloadSap: null,
                responseHubspot: null,
                responseSap: buildErrorResponseSnapshot(error),
              })
            );
          }
        }

        logger.error({
          msg: 'Webhook event processing failed',
          tenantId: tenantId || null,
          tenantKey: tenantKey || null,
          eventId: String(event._id),
          retries: nextRetries,
          maxRetries: configuredMaxRetries,
          nextStatus,
          error: error.message,
        });
      }
    }

    return summary;
  },
};

export default webhookProcessor;
