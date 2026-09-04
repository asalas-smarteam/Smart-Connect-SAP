import mongoose from 'mongoose';

function getTenantOwnerMappingModel(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for owner mappings');
  }

  const { OwnerMapping } = tenantModels;
  return OwnerMapping;
}

export function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `sapOwnerId` es texto y puede llevar VARIOS códigos separados por coma
// ('100,200,300'): en B1 la misma persona tiene un SalesPersonCode por sucursal.
// Por eso la igualdad exacta no alcanza -- una fila con dos códigos no la
// encontraría por ninguno de los dos -- y se agrega la búsqueda del código como
// elemento de la lista, anclada a coma o extremo para que un '10' no resuelva
// contra el '100' de otra persona.
export async function getMappedOwnerId(hubspotCredentialId, sapOwnerId, tenantModels) {
  if (!hubspotCredentialId || !sapOwnerId) {
    return null;
  }

  const code = String(sapOwnerId).trim();

  if (!code) {
    return null;
  }

  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  const mapping = await OwnerMapping.findOne({
    hubspotCredentialId,
    active: true,
    $or: [
      { sapOwnerId: code },
      { sapOwnerId: { $regex: `(^|,)\\s*${escapeRegExp(code)}\\s*(,|$)` } },
    ],
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
  return OwnerMapping.find({ hubspotCredentialId }).sort({ hubspotOwnerName: 1 });
}

export async function getOwnerMappingById(id, tenantModels) {
  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  return OwnerMapping.findById(id);
}

export async function updateOwnerMappingById(id, payload, tenantModels) {
  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  return OwnerMapping.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true,
  });
}

export async function deleteOwnerMappingById(id, tenantModels) {
  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  return OwnerMapping.findByIdAndDelete(id);
}

export async function createOwnerMapping(payload, tenantModels) {
  const OwnerMapping = getTenantOwnerMappingModel(tenantModels);
  return OwnerMapping.create({
    ...payload,
    source: payload.source || 'manual',
  });
}
