import hubspotAuthService from './hubspotAuthService.js';
import * as hubspotClient from './hubspotClient.js';
import { resolveHubspotPropertyNameBySapField } from '../../domain/orders/order-builder.service.js';
import { toNonEmptyString } from '../../shared/utils/string.utils.js';

export class HubspotWebhookAdapter {
  async getAccessToken({ tenantModels, hubspotCredentials }) {
    return hubspotAuthService.getAccessToken(
      hubspotCredentials.clientConfigId,
      hubspotCredentials,
      tenantModels
    );
  }

  async updateBusinessPartnerIds({
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

  async updateAfterSap({
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
    const resolvedToken = token || await this.getAccessToken({
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
}

export function mergeHubspotResponses(current, next) {
  return {
    deal: next?.deal ?? current?.deal ?? null,
    company: next?.company ?? current?.company ?? null,
    contact: next?.contact ?? current?.contact ?? null,
  };
}

export default HubspotWebhookAdapter;

