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

const associationRegistryService = {
  registerBaseObjectMapping,
  findHubspotIdForSapId,
};

export default associationRegistryService;
