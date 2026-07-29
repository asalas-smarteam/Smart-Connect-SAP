function getTenantAssociationRegistry(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for association registry');
  }
  return tenantModels.AssociationRegistry;
}

async function registerBaseObjectMapping(
  hubspotCredentialId,
  objectType,
  sapId,
  hubspotId,
  tenantModels
) {
  if (!hubspotCredentialId || !objectType || !sapId) {
    return null;
  }

  try {
    const AssociationRegistry = getTenantAssociationRegistry(tenantModels);
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

async function findHubspotIdForSapId(hubspotCredentialId, objectType, sapId, tenantModels) {
  if (!hubspotCredentialId || !objectType || !sapId) {
    return null;
  }

  try {
    const AssociationRegistry = getTenantAssociationRegistry(tenantModels);
    const record = await AssociationRegistry.findOne({
      hubspotCredentialId,
      baseObjectType: objectType,
      baseSapId: sapId,
    }).sort({ createdAt: -1 });

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

async function findHubspotIdsForSapIds(hubspotCredentialId, objectType, sapIds, tenantModels) {
  const result = new Map();

  if (!hubspotCredentialId || !objectType || !Array.isArray(sapIds) || sapIds.length === 0) {
    return result;
  }

  try {
    const AssociationRegistry = getTenantAssociationRegistry(tenantModels);
    const records = await AssociationRegistry.find({
      hubspotCredentialId,
      baseObjectType: objectType,
      baseSapId: { $in: sapIds.map((sapId) => String(sapId)) },
    }).sort({ createdAt: -1 });

    for (const record of records ?? []) {
      const key = String(record.baseSapId);
      // Sorted newest-first: the first hit per sapId mirrors findHubspotIdForSapId.
      if (!result.has(key) && record.baseHubspotId) {
        result.set(key, record.baseHubspotId);
      }
    }
  } catch (error) {
    console.error('Failed to bulk-find HubSpot IDs for SAP IDs', {
      hubspotCredentialId,
      objectType,
      error,
    });
  }

  return result;
}

async function registerBaseObjectMappings(hubspotCredentialId, objectType, mappings, tenantModels) {
  const docs = (Array.isArray(mappings) ? mappings : [])
    .filter((mapping) => mapping?.sapId)
    .map(({ sapId, hubspotId }) => ({
      hubspotCredentialId,
      baseObjectType: objectType,
      baseSapId: String(sapId),
      baseHubspotId: hubspotId ?? '',
      associatedObjectType: null,
      associatedSapId: null,
      associatedHubspotId: null,
      quantity: null,
    }));

  if (!hubspotCredentialId || !objectType || docs.length === 0) {
    return [];
  }

  try {
    const AssociationRegistry = getTenantAssociationRegistry(tenantModels);
    return await AssociationRegistry.insertMany(docs, { ordered: false });
  } catch (error) {
    console.error('Failed to bulk-register base object mappings', {
      hubspotCredentialId,
      objectType,
      count: docs.length,
      error,
    });
    return [];
  }
}

const associationRegistryService = {
  registerBaseObjectMapping,
  findHubspotIdForSapId,
  findHubspotIdsForSapIds,
  registerBaseObjectMappings,
};

export default associationRegistryService;
