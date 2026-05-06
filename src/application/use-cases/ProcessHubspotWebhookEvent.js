import {
  buildOrderPayload,
  mapDocumentLines,
  mapHubspotToSapFields,
} from '../../domain/orders/order-builder.service.js';
import {
  resolveEventPayload,
  resolveHubspotSapId,
} from '../services/webhook-payload.service.js';
import { toNonEmptyString } from '../../shared/utils/string.utils.js';

export class ProcessHubspotWebhookEvent {
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
  }

  async execute({ event, tenantModels, tenantId, tenantKey, portalId }) {
    const { payload, deal, company, contact, lineItems } = resolveEventPayload(event);
    const WebhookEvent = tenantModels?.WebhookEvent;
    const companyExists = Boolean(company);
    const contactExists = Boolean(contact);
    const auditTrail = this.createAuditTrail(payload);

    try {
      const context = await this.runtimeRepository.resolveRuntimeContext({
        tenantModels,
        payload,
        tenantId,
        tenantKey,
        portalId,
      });

      const { mappings, sapConfig, hubspotCredentials } = context;
      const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings);
      const mappedContact = mapHubspotToSapFields(contact || {}, mappings.contactBusinessPartnerMappings);
      const businessPartnerResult = await this.sapOrderAdapter.findOrCreateBusinessPartner({
        sapConfig,
        tenantModels,
        company,
        contact,
        mappedCompany,
        mappedContact,
        companyExists: companyExists || !contactExists,
        resolveDefaultPriceListNum: (models) =>
          this.runtimeRepository.resolveDefaultPriceListNum(models),
      });

      auditTrail.payload_SAP.businessPartner = businessPartnerResult.requestPayload;
      auditTrail.response_SAP.businessPartner = businessPartnerResult.responsePayload;

      const cardCode = businessPartnerResult.cardCode;
      const syncPlan = this.resolveBusinessPartnerSyncPlan({
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
        hubspotToken = await this.hubspotWebhookAdapter.getAccessToken({
          tenantModels,
          hubspotCredentials,
        });
        auditTrail.response_hubspot = await this.hubspotWebhookAdapter.updateBusinessPartnerIds({
          token: hubspotToken,
          payload,
          cardCode,
          syncCompany: syncPlan.shouldSyncCompanySapId,
          syncContact: syncPlan.shouldSyncContactSapId,
        });
      }

      if (businessPartnerResult.created) {
        await this.webhookReferenceRepository.persistReferences({
          WebhookEvent,
          eventId: event?._id,
          payload,
          companyExists,
          contactExists,
          cardCode,
        });
      }

      if (companyExists && contactExists) {
        contactEmployeeResult = await this.sapOrderAdapter.addContactEmployeeIfNeeded({
          sapConfig,
          cardCode,
          businessPartner: businessPartnerResult.businessPartner,
          contact,
          contactEmployeeMappings: mappings.contactEmployeeMappings,
        });
      }

      if (contactEmployeeResult.internalCode) {
        await this.webhookReferenceRepository.persistReferences({
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
      const orderPayload = buildOrderPayload({
        cardCode,
        documentLines,
      });
      auditTrail.payload_SAP.order = orderPayload;

      const orderResponse = await this.sapOrderAdapter.createOrder({
        sapConfig,
        orderPayload,
      });
      auditTrail.response_SAP.order = orderResponse;

      const hubspotFinalResponses = await this.hubspotWebhookAdapter.updateAfterSap({
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
      auditTrail.response_hubspot = this.mergeHubspotResponses(
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
        this.buildWebhookSyncErrorEntry({
          payloadHubspot: auditTrail.payload_Hubspot,
          payloadSap: auditTrail.payload_SAP,
          responseHubspot: auditTrail.response_hubspot,
          responseSap: {
            ...auditTrail.response_SAP,
            error: this.buildErrorResponseSnapshot(error),
          },
        }),
      ];

      throw error;
    }
  }

  createAuditTrail(payload) {
    return {
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
  }

  resolveBusinessPartnerSyncPlan({
    businessPartnerResult,
    company,
    contact,
    companyExists,
    contactExists,
  }) {
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

    return {
      shouldSyncCompanySapId,
      shouldSyncContactSapId,
      shouldSyncBusinessPartnerIds: shouldSyncCompanySapId || shouldSyncContactSapId,
    };
  }

  mergeHubspotResponses(current, next) {
    return {
      deal: next?.deal ?? current?.deal ?? null,
      company: next?.company ?? current?.company ?? null,
      contact: next?.contact ?? current?.contact ?? null,
    };
  }
}

export default ProcessHubspotWebhookEvent;
