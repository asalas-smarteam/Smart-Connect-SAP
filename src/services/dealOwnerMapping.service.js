import DealOwnerMapping from '../db/models/DealOwnerMapping.js';

export async function getMappedOwnerId(hubspotCredentialId, sapOwnerId) {
  if (!hubspotCredentialId || !sapOwnerId) {
    return null;
  }

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
) {
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

export async function listOwnerMappings(hubspotCredentialId) {
  if (!hubspotCredentialId) {
    return [];
  }

  return DealOwnerMapping.find({ hubspotCredentialId }).sort({ sapOwnerId: 1 });
}
