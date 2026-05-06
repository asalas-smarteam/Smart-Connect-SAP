import axios from 'axios';
import https from 'https';
import sapSessionManager, { isSessionInvalidError } from '../../services/sapSessionManager.js';
import {
  buildDefaultBusinessPartnerCardCode,
  mapHubspotToSapFields,
  resolveContactDisplayName,
} from '../../domain/orders/order-builder.service.js';
import { PermanentWebhookError } from '../../shared/errors/index.js';
import {
  escapeODataString,
  normalizeNumber,
  toNonEmptyString,
} from '../../shared/utils/string.utils.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function cleanBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
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

export class SapWebhookOrderAdapter {
  async request(sapConfig, { method, path, data, params }) {
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

  async findBusinessPartnerByCardCode(sapConfig, cardCode) {
    if (!toNonEmptyString(cardCode)) {
      return null;
    }

    try {
      return await this.request(sapConfig, {
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

  async findBusinessPartnerByEmail(sapConfig, email) {
    if (!toNonEmptyString(email)) {
      return null;
    }

    const response = await this.request(sapConfig, {
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

  async findOrCreateBusinessPartner({
    sapConfig,
    tenantModels,
    company,
    contact,
    mappedCompany,
    mappedContact,
    companyExists,
    resolveDefaultPriceListNum,
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

    const byCardCode = await this.findBusinessPartnerByCardCode(sapConfig, mappedCardCode);
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

    const byEmail = await this.findBusinessPartnerByEmail(sapConfig, mappedEmail);
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
    const federalTaxId = companyExists
      ? mappedCompany?.FederalTaxID
      : mappedContact?.FederalTaxID;

    if (!cardName) {
      throw new PermanentWebhookError('CardName is required to create Business Partner');
    }

    const payload = {
      CardName: cardName,
      CardType: 'C',
      CompanyPrivate: companyExists ? 'C' : 'I',
      EmailAddress: mappedEmail || '',
      Phone1: toNonEmptyString(mappedCompany?.Phone1 || mappedContact?.Phone1) || undefined,
      PriceListNum: resolvedPriceListNum,
      CardCode: resolvedCardCode,
      FederalTaxID: toNonEmptyString(federalTaxId) || undefined,
    };

    const created = await this.request(sapConfig, {
      method: 'post',
      path: '/BusinessPartners',
      data: payload,
    });

    const cardCode = created?.CardCode || resolvedCardCode || null;
    if (!cardCode) {
      throw new Error('SAP BusinessPartner creation did not return CardCode');
    }

    const businessPartner = await this.findBusinessPartnerByCardCode(sapConfig, cardCode);
    return {
      cardCode,
      created: true,
      matchedBy: null,
      businessPartner,
      requestPayload: payload,
      responsePayload: created,
    };
  }

  async addContactEmployeeIfNeeded({
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

    await this.request(sapConfig, {
      method: 'patch',
      path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
      data: {
        ContactEmployees: [...currentEmployees, nextEmployee],
      },
    });

    const refreshedBusinessPartner = await this.findBusinessPartnerByCardCode(sapConfig, cardCode);
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

  async createOrder({ sapConfig, orderPayload }) {
    return this.request(sapConfig, {
      method: 'post',
      path: '/Orders',
      data: orderPayload,
    });
  }
}

export default SapWebhookOrderAdapter;

