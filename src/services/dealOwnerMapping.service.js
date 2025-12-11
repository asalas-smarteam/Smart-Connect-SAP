import { DealOwnerMapping } from '../config/database.js';

export async function getMappedOwnerId(hubspotCredentialId, sapOwnerId) {
  if (!hubspotCredentialId || !sapOwnerId) {
    return null;
  }

  const mapping = await DealOwnerMapping.findOne({
    where: { hubspotCredentialId, sapOwnerId },
  });

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
  const existing = await DealOwnerMapping.findOne({
    where: { hubspotCredentialId, sapOwnerId },
  });

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

  return DealOwnerMapping.findAll({
    where: { hubspotCredentialId },
    order: [['sapOwnerId', 'ASC']],
  });
}
