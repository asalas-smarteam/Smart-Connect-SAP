import {
  buildOrderPayload,
  mapDocumentLines,
  mapHubspotToSapFields,
  resolvePaymentGroupCode,
} from '#domain/orders/order-builder.service.js';
import {
  resolveDealContactEmployeeCode,
  resolveEventPayload,
  resolveHubspotSapId,
} from '../services/webhook-payload.service.js';
import { createNoopSapCallRecorder } from '../services/sap-call-audit.service.js';
import {
  buildContactEmployeeFailureMessage,
  recordContactEmployeeFailures,
} from '../services/contact-employee-failures.service.js';
import { resolveBusinessPartnerAndContactEmployees } from '#domain/business-partners/contact-employee-source.service.js';
import { buildBpAddresses } from '#domain/business-partners/bp-addresses.service.js';
import { buildSapPropertiesFlags } from '#domain/business-partners/sap-properties-flags.service.js';
import { BusinessPartnerPayloadStrategyFactory } from '#domain/business-partners/business-partner-payload.factory.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import FullMappedBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/full-mapped-bp-payload.strategy.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';
import { PermanentWebhookError } from '#shared/errors/index.js';

// Dead in production since composition always passes an explicit factory (see
// webhook-processing.composition.js). Kept only as a defensive default for direct
// construction, e.g. tests that don't go through composition: it keeps the payload
// byte-for-byte identical to what the adapter built before payload strategies existed.
function createDefaultBusinessPartnerPayloadStrategyFactory() {
  return new BusinessPartnerPayloadStrategyFactory({
    legacyStrategy: new LegacyWhitelistBusinessPartnerPayloadStrategy(),
    fullMappedStrategy: new FullMappedBusinessPartnerPayloadStrategy(),
  });
}

export class ProcessHubspotWebhookEvent {
  constructor({
    runtimeRepository,
    sapOrderAdapter,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    webhookEventProgressRepository,
    businessPartnerPayloadStrategyFactory = createDefaultBusinessPartnerPayloadStrategyFactory(),
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    createSapCallRecorder = createNoopSapCallRecorder,
    logger = { warn: () => {} },
  }) {
    this.runtimeRepository = runtimeRepository;
    this.sapOrderAdapter = sapOrderAdapter;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.webhookEventProgressRepository = webhookEventProgressRepository;
    this.createSapCallRecorder = createSapCallRecorder;
    this.businessPartnerPayloadStrategyFactory = businessPartnerPayloadStrategyFactory;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSapAudit = buildWebhookSapAudit;
    this.logger = logger;
  }

  async execute({ event, tenantModels, tenantId, tenantKey, portalId }) {
    const { payload, deal, company, contact, lineItems, contactEmployees, bpAddress } = resolveEventPayload(event);
    const WebhookEvent = tenantModels?.WebhookEvent;
    const companyExists = Boolean(company);
    const contactExists = Boolean(contact);
    // El grabador comparte el array con el auditTrail por referencia, así que el catch ve
    // todas las llamadas sin que nadie tenga que propagarlas paso por paso.
    const sapCallRecorder = this.createSapCallRecorder();
    const auditTrail = this.createAuditTrail(payload, sapCallRecorder.calls);
    const sapOrderAdapter = sapCallRecorder.wrap(this.sapOrderAdapter);
    let orderResponse = null;
    let cardCode = null;

    try {
      const context = await this.runtimeRepository.resolveRuntimeContext({
        tenantModels,
        payload,
        tenantId,
        tenantKey,
        portalId,
      });

      const {
        mappings,
        sapConfig,
        hubspotCredentials,
        taxCodes,
        miscPriceCalculationConfig,
        discountConfig,
      } = context;
      const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings);
      const mappedContact = mapHubspotToSapFields(contact || {}, mappings.contactBusinessPartnerMappings);
      // Resolved once per event (not a resolver-per-item like the others below) so
      // findOrCreateBusinessPartner/addContactEmployeeIfNeeded don't each trigger their own read.
      const upsertConfig = await this.runtimeRepository.resolveUpsertDataSap(tenantModels);
      const creationConfig = await this.runtimeRepository.resolveBusinessPartnerCreationConfig(tenantModels);
      const propertiesConfig = await this.runtimeRepository.resolvePropertiesFlagsConfig(tenantModels);
      const sapErrorBypass = await this.runtimeRepository.resolveSapErrorBypassConfig(tenantModels);

      const businessPartnerShape = resolveBusinessPartnerAndContactEmployees({
        company,
        contact,
        contactEmployees,
        source: creationConfig.contactEmployeeSource,
      });

      for (const warning of businessPartnerShape.warnings) {
        this.logger?.warn?.({ msg: 'BusinessPartner shape warning', ...warning });
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
        this.logger?.warn?.({ msg: 'BPAddresses warning', ...warning });
      }

      const mappedContactEmployees = businessPartnerShape.contactEmployeeSources.map((source) => ({
        ...creationConfig.defaults.ContactEmployee,
        ...mapHubspotToSapFields(source, mappings.contactEmployeeMappings),
      }));

      const { flags: propertiesFlags, invalid: invalidProperties } = buildSapPropertiesFlags({
        hubspotValue: propertiesConfig.hubspotProperty
          ? businessPartnerShape.businessPartner?.[propertiesConfig.hubspotProperty]
          : null,
        config: propertiesConfig,
      });

      if (invalidProperties.length > 0) {
        this.logger?.warn?.({ msg: 'PropertiesN values ignored', invalid: invalidProperties });
      }

      const payloadStrategy = this.businessPartnerPayloadStrategyFactory
        .getStrategy(creationConfig.payloadStrategy);

      const businessPartnerResult = await sapOrderAdapter.findOrCreateBusinessPartner({
        sapConfig,
        tenantModels,
        company,
        contact,
        mappedCompany,
        mappedContact,
        companyExists: businessPartnerShape.isCompanyBusinessPartner,
        resolveDefaultPriceListNum: (models) =>
          this.runtimeRepository.resolveDefaultPriceListNum(models),
        resolveRequireRandCardCode: (models) =>
          this.runtimeRepository.resolveRequireRandCardCode(models),
        resolveDefaultSeries: (models) =>
          this.runtimeRepository.resolveDefaultSeries(models),
        resolveDefaultFindSAP: (models) =>
          this.runtimeRepository.resolveDefaultFindSAP(models),
        resolveGroupCodeDefaults: (models) =>
          this.runtimeRepository.resolveGroupCodeDefaults(models),
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

      cardCode = businessPartnerResult.cardCode;
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
        internalCodes: [],
        requestPayload: null,
        responsePayload: null,
        updateResults: [],
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

      // Si la strategy ya mandó los ContactEmployees anidados en el POST, un
      // PATCH posterior los duplicaría. Si el BP ya existía, se reconcilian.
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
        await this.webhookReferenceRepository.persistReferences({
          WebhookEvent,
          eventId: event?._id,
          payload,
          companyExists,
          contactExists,
          contactEmployeeCode: contactEmployeeResult.internalCodes[0].internalCode,
          dealContactIsContactEmployee: businessPartnerShape.dealContactIsContactEmployee,
        });
      }

      if (contactEmployeeResult.internalCodes?.length > 0) {
        const tokenForContactEmployees = hubspotToken || await this.hubspotWebhookAdapter.getAccessToken({
          tenantModels,
          hubspotCredentials,
        });

        auditTrail.response_hubspot_contactEmployees = await this.hubspotWebhookAdapter
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
        logger: this.logger,
        cardCode,
        dealId: toNonEmptyString(deal?.hs_object_id),
      });

      // Mismo punto de corte que en resolveBusinessPartnerForDocument (ver el comentario
      // largo ahí): la orden todavía no existe, así que tirar acá es lo que evita
      // sincronizar un negocio cuya data hay que corregir en HubSpot.
      if (contactEmployeeFailures.length > 0 && !sapErrorBypass.contactEmployee) {
        throw new PermanentWebhookError(
          buildContactEmployeeFailureMessage(contactEmployeeFailures)
        );
      }

      const documentLines = mapDocumentLines({
        lineItems,
        productMappings: mappings.productMappings,
        lineMappings: mappings.productOrdersQuotationsMappings,
        taxCodes,
        miscPriceCalculationConfig,
        discountConfig,
        logger: this.logger,
      });
      const slpCode = await this.resolveOrderSlpCode({
        tenantModels,
        deal,
        hubspotCredentials,
      });

      const mappedDeal = mapHubspotToSapFields(
        deal || {},
        mappings.dealOrdersQuotationsMappings,
        { logger: this.logger }
      );
      const groupCodeDefaults = await this.runtimeRepository.resolveGroupCodeDefaults(tenantModels);
      const paymentGroupCode = resolvePaymentGroupCode({ mappedDeal, groupCodeDefaults });

      const orderPayload = buildOrderPayload({
        cardCode,
        documentLines,
        slpCode,
        paymentGroupCode,
        mappedDealFields: mappedDeal,
      });

      auditTrail.payload_SAP.order = orderPayload;

      orderResponse = await sapOrderAdapter.createOrder({
        sapConfig,
        orderPayload,
      });
      auditTrail.response_SAP.order = orderResponse;
      await this.webhookEventProgressRepository?.markOrderCreated({
        WebhookEvent,
        eventId: event?._id,
        result: {
          cardCode,
          docEntry: orderResponse?.DocEntry ?? null,
          docNum: orderResponse?.DocNum ?? null,
          payloadSap: orderPayload,
        },
      });

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
        contactEmployeeCode: resolveDealContactEmployeeCode({
          dealContactIsContactEmployee: businessPartnerShape.dealContactIsContactEmployee,
          internalCodes: contactEmployeeResult.internalCodes,
        }),
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
        contactEmployeeFailures,
        sapAudit: this.buildWebhookSapAudit(auditTrail),
      };
    } catch (error) {
      try {
        error.sapAudit = this.buildWebhookSapAudit(auditTrail);
      } catch {
        error.sapAudit = null;
      }

      if (orderResponse) {
        error.sapOrderCreated = true;
        error.sapOrderResult = {
          cardCode,
          docEntry: orderResponse?.DocEntry ?? null,
          docNum: orderResponse?.DocNum ?? null,
        };
      }

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

  createAuditTrail(payload, sapCalls = []) {
    return {
      payload_Hubspot: payload,
      sapCalls,
      payload_SAP: {
        businessPartner: null,
        businessPartnerUpdate: null,
        contactEmployee: null,
        contactEmployeeUpdate: null,
        order: null,
      },
      response_hubspot: null,
      response_SAP: {
        businessPartner: null,
        businessPartnerUpdate: null,
        contactEmployee: null,
        contactEmployeeUpdate: null,
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

  mergeHubspotResponses(current, next) {
    return {
      deal: next?.deal ?? current?.deal ?? null,
      company: next?.company ?? current?.company ?? null,
      contact: next?.contact ?? current?.contact ?? null,
    };
  }

  async resolveOrderSlpCode({ tenantModels, deal, hubspotCredentials }) {
    const hubspotOwnerId = toNonEmptyString(deal?.hubspot_owner_id);
    const dealId = toNonEmptyString(deal?.hs_object_id);

    if (!hubspotOwnerId) {
      this.logger?.warn?.({
        msg: 'SAP owner not resolved because HubSpot deal owner is missing',
        dealId,
      });
      return null;
    }

    const mapping = await this.runtimeRepository.findOwnerMappingByHubspotOwner({
      tenantModels,
      hubspotCredentialId: hubspotCredentials?._id,
      hubspotOwnerId,
    });
    const sapOwnerId = toNonEmptyString(mapping?.sapOwnerId);

    if (!sapOwnerId) {
      this.logger?.warn?.({
        msg: 'SAP owner mapping not found for HubSpot owner',
        hubspotOwnerId,
        dealId,
      });
      return null;
    }

    const slpCode = Number(sapOwnerId);
    if (!Number.isInteger(slpCode)) {
      this.logger?.warn?.({
        msg: 'SAP owner mapping has invalid sapOwnerId',
        hubspotOwnerId,
        sapOwnerId,
        dealId,
      });
      return null;
    }

    return slpCode;
  }
}

export default ProcessHubspotWebhookEvent;
