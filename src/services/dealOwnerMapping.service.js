function getTenantOwnerMappingModel(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for owner mappings');
  }

  const { OwnerMapping } = tenantModels;
  return OwnerMapping;
}

export async function getMappedOwnerId(hubspotCredentialId, sapOwnerId, tenantModels) {
  if (!hubspotCredentialId || !sapOwnerId) {
    return null;
  }

  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  const mapping = await OwnerMapping.findOne({ hubspotCredentialId, sapOwnerId, active: true });

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
  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  const existing = await OwnerMapping.findOne({ hubspotCredentialId, sapOwnerId });

  if (existing) {
    existing.hubspotOwnerId = hubspotOwnerId;
    existing.hubspotOwnerName = displayName;
    existing.active = true;
    return existing.save();
  }

  return OwnerMapping.create({
    hubspotCredentialId,
    sapOwnerId,
    hubspotOwnerId,
    hubspotOwnerName: displayName,
  });
}

export async function listOwnerMappings(hubspotCredentialId, tenantModels) {
  if (!hubspotCredentialId) {
    return [];
  }

  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  return OwnerMapping.find({ hubspotCredentialId }).sort({ sapOwnerId: 1, hubspotOwnerId: 1 });
}
