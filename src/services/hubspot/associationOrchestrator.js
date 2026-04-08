import axios from 'axios';
import associationRegistryService from '../associationRegistryService.js';
import associationService from '../associationService.js';
import mappingService from '../mapping.service.js';
import { getConnection } from '../../utils/externalDb.js';
import contactHandler from './handlers/contact.handler.js';
import { generateFallbackEmail } from './utils/email.utils.js';

export const ASSOCIATION_MAP = {
  deal: ['contact', 'company', 'product'],
  contact: ['company'],
  company: ['contact'],
};

async function fetchAssociationsIfNeeded(clientConfig, objectType) {
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
    const rawResult = await executeAssociationFetch(config, clientConfig);
    const normalized = normalizeAssociationValues(rawResult, associationType);

    const key =
      associationType === 'contact'
        ? 'contacts'
        : associationType === 'company'
          ? 'companies'
          : 'products';

    aggregated[key] = normalized;
  }

  if (!hasConfig) {
    return null;
  }

  return aggregated;
}

async function executeAssociationFetch(config, clientConfig) {
  const fetchType = config?.associationFetchType;
  const fetchConfig = config?.associationFetchConfig;

  if (!fetchType || !fetchConfig) {
    return {};
  }

  if (fetchType === 'api') {
    const response = await axios({
      method: fetchConfig.method || 'GET',
      url: fetchConfig.url,
    });

    return response?.data ?? response;
  }

  if (fetchType === 'sp') {
    const storedProcedure =
      fetchConfig.storedProcedure || fetchConfig.storeProcedureName;

    if (!storedProcedure) {
      return {};
    }

    const externalSequelize = getConnection(clientConfig);
    const [results] = await externalSequelize.query(`EXEC ${storedProcedure}`);

    return results ?? {};
  }

  return {};
}

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

async function resolveAssociationIds(clientConfig, objectType, associationValues, tenantModels) {
  if (!Array.isArray(associationValues)) {
    return [];
  }

  const hubspotCredentialId = clientConfig?.hubspotCredentialId;
  const isProduct = objectType === 'product';
  const resolved = [];

  for (const value of associationValues) {
    const sapId = value?.sapId ?? value;
    const quantity = value?.qty ?? value?.quantity ?? null;

    const hubspotId = await associationRegistryService.findHubspotIdForSapId(
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

async function syncCompanyContacts({
  token,
  item,
  clientConfig,
  tenantModels,
  companyHubspotId,
}) {
  try {
    const sapContacts = item?.rawSapData?.ContactEmployees || [];

    if (!Array.isArray(sapContacts) || sapContacts.length === 0) {
      return;
    }

    const contactMappings = await mappingService.getMappingsByObjectType(
      clientConfig.hubspotCredentialId,
      'contact',
      'contactEmployee',
      tenantModels
    );

    if (!Array.isArray(contactMappings) || contactMappings.length === 0) {
      console.warn('No contactEmployee mappings found for company contact sync');
    }

    const mappedContacts = await mappingService.mapRecords(
      sapContacts,
      clientConfig.hubspotCredentialId,
      'contact',
      tenantModels,
      'contactEmployee'
    );

    for (const [index, mappedContact] of mappedContacts.entries()) {
      const sapContact = sapContacts[index] || {};
      const sapInternalCode = sapContact?.InternalCode;
      const contactPayload = {
        ...mappedContact,
        properties: {
          ...(mappedContact?.properties || {}),
        },
      };

      if (!contactPayload.properties.email) {
        const fallbackEmail = generateFallbackEmail(
          item?.rawSapData?.EmailAddress,
          sapInternalCode
        );

        if (fallbackEmail) {
          contactPayload.properties.email = fallbackEmail;
        }
      }

      const existingContact = await contactHandler.find({
        token,
        item: contactPayload,
        clientConfig,
        tenantModels,
      });
      let createdContact;

      if (existingContact) {
        await contactHandler.update({
          token,
          id: existingContact.id,
          item: contactPayload,
          clientConfig,
          tenantModels,
        });
      } else {
        createdContact = await contactHandler.create({
          token,
          item: contactPayload,
          clientConfig,
          tenantModels,
        });

        if (createdContact?.id && sapInternalCode) {
          await associationRegistryService.registerBaseObjectMapping(
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
        await associationService.associateCompanyWithContacts(
          token,
          clientConfig.hubspotCredentialId,
          companyHubspotId,
          [{ hubspotId: contactHubspotId, sapId: sapInternalCode }],
          tenantModels
        );
      }
    }
  } catch (contactSyncError) {
    console.error('Company contact sync error:', contactSyncError);
  }
}

async function handleContactAssociations({
  token,
  item,
  clientConfig,
  tenantModels,
  hubspotId,
}) {
  const associationsRoot = item?.properties?.associations || {};
  let associatedCompanies = associationsRoot.companies || [];

  if (associatedCompanies.length === 0 && clientConfig.associationFetchEnabled) {
    const fallback = await fetchAssociationsIfNeeded(clientConfig, 'contact');

    if (fallback) {
      associatedCompanies = fallback.companies || [];
    }
  }

  const companyAssociations = await resolveAssociationIds(
    clientConfig,
    'company',
    associatedCompanies,
    tenantModels
  );

  await associationService.associateContactWithCompanies(
    token,
    clientConfig.hubspotCredentialId,
    hubspotId,
    companyAssociations,
    tenantModels
  );
}

async function handleCompanyAssociations({
  token,
  item,
  clientConfig,
  tenantModels,
  hubspotId,
}) {
  const associationsRoot = item?.properties?.associations || {};
  let associatedContacts = associationsRoot.contacts || [];

  if (associatedContacts.length === 0 && clientConfig.associationFetchEnabled) {
    const fallback = await fetchAssociationsIfNeeded(clientConfig, 'company');

    if (fallback) {
      associatedContacts = fallback.contacts || [];
    }
  }

  const contactAssociations = await resolveAssociationIds(
    clientConfig,
    'contact',
    associatedContacts,
    tenantModels
  );

  await associationService.associateCompanyWithContacts(
    token,
    clientConfig.hubspotCredentialId,
    hubspotId,
    contactAssociations,
    tenantModels
  );

  await syncCompanyContacts({
    token,
    item,
    clientConfig,
    tenantModels,
    companyHubspotId: hubspotId,
  });
}

async function handleDealAssociations({
  token,
  item,
  clientConfig,
  tenantModels,
  hubspotId,
}) {
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
    const fallback = await fetchAssociationsIfNeeded(clientConfig, 'deal');

    if (fallback) {
      associatedContacts = fallback.contacts || [];
      associatedCompanies = fallback.companies || [];
      associatedProducts = fallback.products || [];
    }
  }

  const contactAssociations = await resolveAssociationIds(
    clientConfig,
    'contact',
    associatedContacts,
    tenantModels
  );
  const companyAssociations = await resolveAssociationIds(
    clientConfig,
    'company',
    associatedCompanies,
    tenantModels
  );
  const productAssociations = await resolveAssociationIds(
    clientConfig,
    'product',
    associatedProducts,
    tenantModels
  );

  await associationService.associateDealWithContacts(
    token,
    clientConfig.hubspotCredentialId,
    hubspotId,
    contactAssociations,
    tenantModels
  );
  await associationService.associateDealWithCompanies(
    token,
    clientConfig.hubspotCredentialId,
    hubspotId,
    companyAssociations,
    tenantModels
  );
  await associationService.associateDealWithProducts(
    token,
    clientConfig.hubspotCredentialId,
    hubspotId,
    productAssociations,
    tenantModels
  );
}

export async function handleAssociations({
  objectType,
  token,
  item,
  clientConfig,
  tenantModels,
  hubspotId,
}) {
  if (!hubspotId || !ASSOCIATION_MAP[objectType]) {
    return;
  }

  if (objectType === 'contact') {
    await handleContactAssociations({
      token,
      item,
      clientConfig,
      tenantModels,
      hubspotId,
    });
    return;
  }

  if (objectType === 'company') {
    await handleCompanyAssociations({
      token,
      item,
      clientConfig,
      tenantModels,
      hubspotId,
    });
    return;
  }

  if (objectType === 'deal') {
    await handleDealAssociations({
      token,
      item,
      clientConfig,
      tenantModels,
      hubspotId,
    });
  }
}

export default {
  ASSOCIATION_MAP,
  handleAssociations,
};
