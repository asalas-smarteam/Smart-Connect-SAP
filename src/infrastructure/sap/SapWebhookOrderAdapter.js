import { sapServiceLayerWebhookRequest } from './sapServiceLayerWebhookRequest.js';
import {
  buildDefaultBusinessPartnerCardCode,
  mapHubspotToSapFields,
  resolveContactDisplayName,
} from '#domain/orders/order-builder.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import {
  escapeODataString,
  normalizeNumber,
  toNonEmptyString,
} from '#shared/utils/string.utils.js';

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
  async request(sapConfig, options) {
    return sapServiceLayerWebhookRequest(sapConfig, options);
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

  async findBusinessPartnerByField(sapConfig, fieldName, fieldValue) {
    const resolvedFieldName = toNonEmptyString(fieldName);
    const resolvedFieldValue = toNonEmptyString(fieldValue);

    if (!resolvedFieldName || !resolvedFieldValue) {
      return null;
    }

    const selectFields = [
      'CardCode',
      'CardName',
      'EmailAddress',
      'Phone1',
      'PriceListNum',
      'ContactEmployees',
      resolvedFieldName,
    ];

    const response = await this.request(sapConfig, {
      method: 'get',
      path: '/BusinessPartners',
      params: {
        $top: 1,
        $select: [...new Set(selectFields)].join(','),
        $filter: `${resolvedFieldName} eq '${escapeODataString(resolvedFieldValue)}'`,
      },
    });

    return Array.isArray(response?.value) && response.value.length > 0
      ? response.value[0]
      : null;
  }

  async findBusinessPartnerByEmail(sapConfig, email) {
    return this.findBusinessPartnerByField(sapConfig, 'EmailAddress', email);
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
    resolveRequireRandCardCode = async () => true,
    resolveDefaultSeries = async () => null,
    resolveDefaultFindSAP = async () => 'EmailAddress',
  }) {
    const mappedCardCode = toNonEmptyString(mappedCompany?.CardCode || mappedContact?.CardCode);
    const mappedEmail = toNonEmptyString(mappedCompany?.EmailAddress || mappedContact?.EmailAddress);
    const mappedPriceListNum = normalizeNumber(
      mappedCompany?.PriceListNum ?? mappedContact?.PriceListNum,
      null
    );
    const shouldGenerateDefaultCardCode = mappedCardCode
      ? false
      : await resolveRequireRandCardCode(tenantModels);
    const resolvedCardCode = mappedCardCode || (
      shouldGenerateDefaultCardCode
        ? buildDefaultBusinessPartnerCardCode({
          company,
          contact,
          companyExists,
        })
        : null
    );
    const resolvedPriceListNum = Number.isFinite(mappedPriceListNum)
      ? mappedPriceListNum
      : await resolveDefaultPriceListNum(tenantModels);
    const defaultFindSAP = await resolveDefaultFindSAP(tenantModels);
    const defaultFindSAPValue = toNonEmptyString(
      mappedCompany?.[defaultFindSAP] || mappedContact?.[defaultFindSAP]
    );

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

    const byDefaultField = await this.findBusinessPartnerByField(
      sapConfig,
      defaultFindSAP,
      defaultFindSAPValue
    );
    if (byDefaultField?.CardCode) {
      return {
        cardCode: byDefaultField.CardCode,
        created: false,
        matchedBy: defaultFindSAP,
        businessPartner: byDefaultField,
        requestPayload: null,
        responsePayload: {
          matchedBy: defaultFindSAP,
          businessPartner: byDefaultField,
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
      FederalTaxID: toNonEmptyString(federalTaxId) || undefined,
      Frozen: 'tNO',
      Valid: 'tYES',
    };

    if (resolvedCardCode) {
      payload.CardCode = resolvedCardCode;
    } else {
      const resolvedDefaultSeries = await resolveDefaultSeries(tenantModels);

      if (resolvedDefaultSeries) {
        payload.Series = resolvedDefaultSeries;
      }
    }

    const created = await this.request(sapConfig, {
      method: 'post',
      path: '/BusinessPartners',
      data: payload,
    });

    const cardCode = toNonEmptyString(created?.CardCode || resolvedCardCode);
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
