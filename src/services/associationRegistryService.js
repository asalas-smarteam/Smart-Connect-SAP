import { AssociationRegistry } from '../config/database.js';

async function registerBaseObjectMapping(
  hubspotCredentialId,
  objectType,
  sapId,
  hubspotId,
) {
  if (!hubspotCredentialId || !objectType || !sapId || !hubspotId) {
    return null;
  }

  try {
    return await AssociationRegistry.create({
      hubspotCredentialId,
      baseObjectType: objectType,
      baseSapId: sapId,
      baseHubspotId: hubspotId,
      associatedObjectType: null,
      associatedSapId: null,
      associatedHubspotId: null,
      quantity: null,
    });
  } catch (error) {
    console.error('Failed to register base object mapping', {
      hubspotCredentialId,
      objectType,
      sapId,
      hubspotId,
      error,
    });
    return null;
  }
}

async function findHubspotIdForSapId(hubspotCredentialId, objectType, sapId) {
  if (!hubspotCredentialId || !objectType || !sapId) {
    return null;
  }

  try {
    const record = await AssociationRegistry.findOne({
      where: {
        hubspotCredentialId,
        baseObjectType: objectType,
        baseSapId: sapId,
      },
      order: [['createdAt', 'DESC']],
    });

    return record?.baseHubspotId ?? null;
  } catch (error) {
    console.error('Failed to find HubSpot ID for SAP ID', {
      hubspotCredentialId,
      objectType,
      sapId,
      error,
    });
    return null;
  }
}

const associationRegistryService = {
  registerBaseObjectMapping,
  findHubspotIdForSapId,
};

export default associationRegistryService;
