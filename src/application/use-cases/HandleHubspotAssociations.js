import {
  applyBypassEmail,
  resolveBypassEmail,
} from '#application/services/bypassEmail.service.js';
import { buildCompanyContactPayload } from '#application/services/companyContactPayload.service.js';

export const ASSOCIATION_MAP = Object.freeze({
  deal: ['contact', 'company', 'product'],
  contact: ['company'],
  company: ['contact'],
});

function normalizeAssociationValues(rawResult, associationType) {
  const key =
    associationType === 'contact'
      ? 'contacts'
      : associationType === 'company'
        ? 'companies'
        : 'products';

  if (Array.isArray(rawResult)) {
    return rawResult;
  }

  if (!rawResult || typeof rawResult !== 'object') {
    return [];
  }

  if (Array.isArray(rawResult[key])) {
    return rawResult[key];
  }

  if (Array.isArray(rawResult[associationType])) {
    return rawResult[associationType];
  }

  return [];
}

// Keeps the canonical { payloadHubspot, responseHubspot } shape used by the
// other SyncLog error entries and adds the ids needed to report the failure
// back to the client. hubspotClient wraps failures with `details`, so a 409
// carries HubSpot's "Contact already exists. Existing ID: X" body.
export function buildContactErrorEntry({
  error,
  sapContactId = null,
  sapCompanyId = null,
  companyHubspotId = null,
  contactPayload = null,
}) {
  return {
    errorType: 'contactEmployee',
    sapContactId,
    sapCompanyId,
    hubspotCompanyId: companyHubspotId ?? null,
    message: error?.message ?? null,
    endpoint: error?.details?.endpoint ?? null,
    status: error?.details?.status ?? null,
    payloadHubspot: contactPayload?.properties ?? null,
    responseHubspot: error?.details?.hubspotResponse ?? null,
  };
}

export class HandleHubspotAssociations {
  constructor({
    associationFetcher,
    associationRegistry,
    associationService,
    fieldMappingService,
    contactHandler,
    fallbackEmailGenerator,
    bypassEmailConfigRepository = null,
    syncWarningRepository = null,
    logger = console,
  }) {
    this.associationFetcher = associationFetcher;
    this.associationRegistry = associationRegistry;
    this.associationService = associationService;
    this.fieldMappingService = fieldMappingService;
    this.contactHandler = contactHandler;
    this.fallbackEmailGenerator = fallbackEmailGenerator;
    this.bypassEmailConfigRepository = bypassEmailConfigRepository;
    this.syncWarningRepository = syncWarningRepository;
    this.logger = logger;
  }

  // Persists a data-quality warning (missing/invalid email) so it can be
  // reported back to the client. Never throws: a warning must not break a sync.
  async recordWarning(payload) {
    if (!this.syncWarningRepository?.record) {
      return null;
    }

    try {
      return await this.syncWarningRepository.record(payload);
    } catch (error) {
      this.logger.error?.('Sync warning record error:', error);
      return null;
    }
  }

  async getBypassEmail({ tenantModels }) {
    return resolveBypassEmail({
      objectType: 'contact',
      tenantModels,
      bypassEmailConfigRepository: this.bypassEmailConfigRepository,
      logger: this.logger,
    });
  }

  async execute({ objectType, token, item, clientConfig, tenantModels, hubspotId, syncLogId = null }) {
    if (!hubspotId || !ASSOCIATION_MAP[objectType]) {
      return;
    }

    if (objectType === 'contact') {
      await this.handleContactAssociations({ token, item, clientConfig, tenantModels, hubspotId });
      return;
    }

    if (objectType === 'company') {
      // Returns { contactErrors } so contactEmployee failures reach the SyncLog.
      return this.handleCompanyAssociations({
        token,
        item,
        clientConfig,
        tenantModels,
        hubspotId,
        syncLogId,
      });
    }

    if (objectType === 'deal') {
      await this.handleDealAssociations({ token, item, clientConfig, tenantModels, hubspotId });
    }
  }

  async fetchAssociationsIfNeeded(clientConfig, objectType) {
    if (!clientConfig?.associationFetchEnabled) {
      return null;
    }

    const configArray = clientConfig.associationFetchConfig;

    if (!Array.isArray(configArray) || configArray.length === 0) {
      return null;
    }

    const associationTypes = ASSOCIATION_MAP[objectType] || [];

    if (associationTypes.length === 0) {
      return null;
    }

    const aggregated = {
      contacts: [],
      companies: [],
      products: [],
    };
    let hasConfig = false;

    for (const associationType of associationTypes) {
      const config = configArray.find((entry) => entry?.objectType === associationType);

      if (!config) {
        continue;
      }

      hasConfig = true;
      const rawResult = await this.associationFetcher.fetch({ config, clientConfig });
      const normalized = normalizeAssociationValues(rawResult, associationType);
      const key =
        associationType === 'contact'
          ? 'contacts'
          : associationType === 'company'
            ? 'companies'
            : 'products';

      aggregated[key] = normalized;
    }

    return hasConfig ? aggregated : null;
  }

  async resolveAssociationIds(clientConfig, objectType, associationValues, tenantModels) {
    if (!Array.isArray(associationValues)) {
      return [];
    }

    const hubspotCredentialId = clientConfig?.hubspotCredentialId;
    const isProduct = objectType === 'product';
    const resolved = [];

    for (const value of associationValues) {
      const sapId = value?.sapId ?? value;
      const quantity = value?.qty ?? value?.quantity ?? null;
      const hubspotId = await this.associationRegistry.findHubspotIdForSapId(
        hubspotCredentialId,
        objectType,
        sapId ? String(sapId) : null,
        tenantModels
      );

      if (isProduct) {
        resolved.push({ hubspotId, sapId, qty: quantity });
      } else {
        resolved.push({ hubspotId, sapId });
      }
    }

    return resolved;
  }

  async syncCompanyContacts({
    token,
    item,
    clientConfig,
    tenantModels,
    companyHubspotId,
    syncLogId = null,
  }) {
    const contactErrors = [];
    // S/4 identifies the company BP with BusinessPartner; B1 with CardCode.
    const sapCompanyId = item?.rawSapData?.BusinessPartner
      ?? item?.rawSapData?.CardCode
      ?? item?.properties?.idsap
      ?? null;
    const clientConfigId = clientConfig?.id ?? clientConfig?._id ?? null;
    let sapContacts;
    let mappedContacts;
    let bypassEmail;

    try {
      // B1 embeds ContactEmployees in the company record; S/4 attaches the
      // resolved contact person-BPs under _s4Contacts (see
      // S4ContactEnrichmentAdapter). Both feed the same contact mappings.
      sapContacts = item?.rawSapData?._s4Contacts
        ?? item?.rawSapData?.ContactEmployees
        ?? [];

      if (!Array.isArray(sapContacts) || sapContacts.length === 0) {
        return { contactErrors };
      }

      const contactMappings = await this.fieldMappingService.getMappingsByObjectType(
        clientConfig.hubspotCredentialId,
        'contact',
        'contactEmployee',
        tenantModels
      );

      if (!Array.isArray(contactMappings) || contactMappings.length === 0) {
        this.logger.warn?.('No contactEmployee mappings found for company contact sync');
      }

      mappedContacts = await this.fieldMappingService.mapRecords(
        sapContacts,
        clientConfig.hubspotCredentialId,
        'contact',
        tenantModels,
        'contactEmployee'
      );
      bypassEmail = await this.getBypassEmail({ tenantModels });
    } catch (setupError) {
      this.logger.error?.('Company contact sync error:', setupError);
      contactErrors.push(buildContactErrorEntry({
        error: setupError,
        sapContactId: null,
        sapCompanyId,
        companyHubspotId,
        contactPayload: null,
      }));
      return { contactErrors };
    }

    for (const [index, mappedContact] of mappedContacts.entries()) {
      const sapContact = sapContacts[index] || {};
      // B1 identifies a contact by InternalCode; S/4 person-BPs use their
      // BusinessPartner id (drives fallback email + SAP->HubSpot registry).
      const { contactPayload: builtPayload, sapInternalCode } = buildCompanyContactPayload({
        mappedContact,
        sapContact,
        companyFallbackSourceEmail: item?.rawSapData?.EmailAddress,
        fallbackEmailGenerator: this.fallbackEmailGenerator,
      });
      // Declared outside the try so the catch below can still report it.
      let contactPayload = null;

      contactPayload = builtPayload;

      // Each contact is isolated: a failure on one (e.g. a HubSpot 409) must
      // not abort the remaining contacts of the same company.
      try {
        const bypassWarnings = [];
        const emailWasBypassed = applyBypassEmail({
          objectType: 'contact',
          item: contactPayload,
          bypassEmail,
          logger: this.logger,
          sapId: sapInternalCode ?? null,
          onWarning: (warning) => bypassWarnings.push(warning),
        });

        for (const warning of bypassWarnings) {
          await this.recordWarning({
            tenantModels,
            clientConfigId,
            syncLogId,
            objectType: 'contact',
            sapId: warning.sapId ?? sapInternalCode ?? null,
            code: warning.code,
            message: warning.message,
            details: {
              source: 'companyContact',
              sapCompanyId,
              hubspotCompanyId: companyHubspotId ?? null,
              email: warning.email ?? null,
            },
          });
        }

        if (!contactPayload.properties.email && !emailWasBypassed) {
          this.logger.error?.(
            'Company contact sync error:',
            new Error('Company contact email is required before HubSpot sync')
          );
          await this.recordWarning({
            tenantModels,
            clientConfigId,
            syncLogId,
            objectType: 'contact',
            sapId: sapInternalCode ?? null,
            code: 'contactEmailMissingSkipped',
            message: 'Company contact skipped: email is required before HubSpot sync',
            details: {
              source: 'companyContact',
              sapCompanyId,
              hubspotCompanyId: companyHubspotId ?? null,
            },
          });
          continue;
        }

        const existingContact = await this.contactHandler.find({
          token,
          item: contactPayload,
          clientConfig,
          tenantModels,
        });
        let createdContact;

        if (existingContact) {
          await this.contactHandler.update({
            token,
            id: existingContact.id,
            existing: existingContact,
            item: contactPayload,
            clientConfig,
            tenantModels,
          });
        } else {
          createdContact = await this.contactHandler.create({
            token,
            item: contactPayload,
            clientConfig,
            tenantModels,
          });

          if (createdContact?.id && sapInternalCode) {
            await this.associationRegistry.registerBaseObjectMapping(
              clientConfig.hubspotCredentialId,
              'contact',
              sapInternalCode,
              createdContact.id,
              tenantModels
            );
          }
        }

        const contactHubspotId = existingContact?.id ?? createdContact?.id;

        if (contactHubspotId) {
          await this.associationService.associateCompanyWithContacts(
            token,
            clientConfig.hubspotCredentialId,
            companyHubspotId,
            [{ hubspotId: contactHubspotId, sapId: sapInternalCode }],
            tenantModels
          );
        }
      } catch (contactSyncError) {
        this.logger.error?.('Company contact sync error:', contactSyncError);
        contactErrors.push(buildContactErrorEntry({
          error: contactSyncError,
          sapContactId: sapInternalCode ?? null,
          sapCompanyId,
          companyHubspotId,
          contactPayload,
        }));
      }
    }

    return { contactErrors };
  }

  async handleContactAssociations({ token, item, clientConfig, tenantModels, hubspotId }) {
    const associationsRoot = item?.properties?.associations || {};
    let associatedCompanies = associationsRoot.companies || [];

    if (associatedCompanies.length === 0 && clientConfig.associationFetchEnabled) {
      const fallback = await this.fetchAssociationsIfNeeded(clientConfig, 'contact');

      if (fallback) {
        associatedCompanies = fallback.companies || [];
      }
    }

    const companyAssociations = await this.resolveAssociationIds(
      clientConfig,
      'company',
      associatedCompanies,
      tenantModels
    );

    await this.associationService.associateContactWithCompanies(
      token,
      clientConfig.hubspotCredentialId,
      hubspotId,
      companyAssociations,
      tenantModels
    );
  }

  async handleCompanyAssociations({ token, item, clientConfig, tenantModels, hubspotId, syncLogId = null }) {
    const associationsRoot = item?.properties?.associations || {};
    let associatedContacts = associationsRoot.contacts || [];

    if (associatedContacts.length === 0 && clientConfig.associationFetchEnabled) {
      const fallback = await this.fetchAssociationsIfNeeded(clientConfig, 'company');

      if (fallback) {
        associatedContacts = fallback.contacts || [];
      }
    }

    const contactAssociations = await this.resolveAssociationIds(
      clientConfig,
      'contact',
      associatedContacts,
      tenantModels
    );

    await this.associationService.associateCompanyWithContacts(
      token,
      clientConfig.hubspotCredentialId,
      hubspotId,
      contactAssociations,
      tenantModels
    );

    return this.syncCompanyContacts({
      token,
      item,
      clientConfig,
      tenantModels,
      companyHubspotId: hubspotId,
      syncLogId,
    });
  }

  async handleDealAssociations({ token, item, clientConfig, tenantModels, hubspotId }) {
    const associationsRoot = item?.properties?.associations || {};
    let associatedContacts = associationsRoot.contacts || [];
    let associatedCompanies = associationsRoot.companies || [];
    let associatedProducts = associationsRoot.products || [];

    if (
      associatedContacts.length === 0 &&
      associatedCompanies.length === 0 &&
      associatedProducts.length === 0 &&
      clientConfig.associationFetchEnabled
    ) {
      const fallback = await this.fetchAssociationsIfNeeded(clientConfig, 'deal');

      if (fallback) {
        associatedContacts = fallback.contacts || [];
        associatedCompanies = fallback.companies || [];
        associatedProducts = fallback.products || [];
      }
    }

    const contactAssociations = await this.resolveAssociationIds(
      clientConfig,
      'contact',
      associatedContacts,
      tenantModels
    );
    const companyAssociations = await this.resolveAssociationIds(
      clientConfig,
      'company',
      associatedCompanies,
      tenantModels
    );
    const productAssociations = await this.resolveAssociationIds(
      clientConfig,
      'product',
      associatedProducts,
      tenantModels
    );

    await this.associationService.associateDealWithContacts(
      token,
      clientConfig.hubspotCredentialId,
      hubspotId,
      contactAssociations,
      tenantModels
    );
    await this.associationService.associateDealWithCompanies(
      token,
      clientConfig.hubspotCredentialId,
      hubspotId,
      companyAssociations,
      tenantModels
    );
    await this.associationService.associateDealWithProducts(
      token,
      clientConfig.hubspotCredentialId,
      hubspotId,
      productAssociations,
      tenantModels
    );
  }
}

export default HandleHubspotAssociations;
