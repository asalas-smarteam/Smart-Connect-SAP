function getTenantDealOwnerModel(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for deal owner mappings');
  }

  const { DealOwnerMapping } = tenantModels;
  return DealOwnerMapping;
}

export async function getMappedOwnerId(hubspotCredentialId, sapOwnerId, tenantModels) {
  if (!hubspotCredentialId || !sapOwnerId) {
    return null;
  }

  const DealOwnerMapping = getTenantDealOwnerModel(tenantModels);
  const mapping = await DealOwnerMapping.findOne({ hubspotCredentialId, sapOwnerId });

  if (!mapping) {
    return null;
  }

  return mapping.hubspotOwnerId;
}

export async function upsertOwnerMapping(
  hubspotCredentialId,
  sapOwnerId,
  hubspotOwnerId,
  displayName,
  tenantModels
) {
  const DealOwnerMapping = getTenantDealOwnerModel(tenantModels);
  const existing = await DealOwnerMapping.findOne({ hubspotCredentialId, sapOwnerId });

  if (existing) {
    existing.hubspotOwnerId = hubspotOwnerId;
    existing.displayName = displayName;
    return existing.save();
  }

  return DealOwnerMapping.create({
    hubspotCredentialId,
    sapOwnerId,
    hubspotOwnerId,
    displayName,
  });
}

export async function listOwnerMappings(hubspotCredentialId, tenantModels) {
  if (!hubspotCredentialId) {
    return [];
  }

  const DealOwnerMapping = getTenantDealOwnerModel(tenantModels);
  return DealOwnerMapping.find({ hubspotCredentialId }).sort({ sapOwnerId: 1 });
}
