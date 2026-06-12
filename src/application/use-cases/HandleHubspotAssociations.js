import {
  applyBypassEmail,
  resolveBypassEmail,
} from '#application/services/bypassEmail.service.js';

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

function getSapContactEmail(sapContact) {
  return String(sapContact?.E_Mail ?? sapContact?.EmailAddress ?? '').trim();
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
    logger = console,
  }) {
    this.associationFetcher = associationFetcher;
    this.associationRegistry = associationRegistry;
    this.associationService = associationService;
    this.fieldMappingService = fieldMappingService;
    this.contactHandler = contactHandler;
    this.fallbackEmailGenerator = fallbackEmailGenerator;
    this.bypassEmailConfigRepository = bypassEmailConfigRepository;
    this.logger = logger;
  }

  async getBypassEmail({ tenantModels }) {
    return resolveBypassEmail({
      objectType: 'contact',
      tenantModels,
      bypassEmailConfigRepository: this.bypassEmailConfigRepository,
      logger: this.logger,
    });
  }

  async execute({ objectType, token, item, clientConfig, tenantModels, hubspotId }) {
    if (!hubspotId || !ASSOCIATION_MAP[objectType]) {
      return;
    }

    if (objectType === 'contact') {
      await this.handleContactAssociations({ token, item, clientConfig, tenantModels, hubspotId });
      return;
    }

    if (objectType === 'company') {
      await this.handleCompanyAssociations({ token, item, clientConfig, tenantModels, hubspotId });
      return;
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

  async syncCompanyContacts({ token, item, clientConfig, tenantModels, companyHubspotId }) {
    try {
      const sapContacts = item?.rawSapData?.ContactEmployees || [];

      if (!Array.isArray(sapContacts) || sapContacts.length === 0) {
        return;
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

      const mappedContacts = await this.fieldMappingService.mapRecords(
        sapContacts,
        clientConfig.hubspotCredentialId,
        'contact',
        tenantModels,
        'contactEmployee'
      );
      const bypassEmail = await this.getBypassEmail({ tenantModels });

      for (const [index, mappedContact] of mappedContacts.entries()) {
        const sapContact = sapContacts[index] || {};
        const sapInternalCode = sapContact?.InternalCode;
        const sapContactEmail = getSapContactEmail(sapContact);
        const contactPayload = {
          ...mappedContact,
          properties: {
            ...(mappedContact?.properties || {}),
          },
        };

        if (sapContactEmail) {
          contactPayload.properties.email = sapContactEmail;
        }

        if (!contactPayload.properties.email) {
          const fallbackEmail = this.fallbackEmailGenerator(
            item?.rawSapData?.EmailAddress,
            sapInternalCode
          );

          if (fallbackEmail) {
            contactPayload.properties.email = fallbackEmail;
          }
        }

        const emailWasBypassed = applyBypassEmail({
          objectType: 'contact',
          item: contactPayload,
          bypassEmail,
          logger: this.logger,
          sapId: sapInternalCode ?? null,
        });

        if (!contactPayload.properties.email && !emailWasBypassed) {
          this.logger.error?.(
            'Company contact sync error:',
            new Error('Company contact email is required before HubSpot sync')
          );
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
      }
    } catch (contactSyncError) {
      this.logger.error?.('Company contact sync error:', contactSyncError);
    }
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

  async handleCompanyAssociations({ token, item, clientConfig, tenantModels, hubspotId }) {
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

    await this.syncCompanyContacts({
      token,
      item,
      clientConfig,
      tenantModels,
      companyHubspotId: hubspotId,
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
