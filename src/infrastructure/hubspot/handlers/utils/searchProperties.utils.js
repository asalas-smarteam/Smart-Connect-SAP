async function resolveQuery(query) {
  if (typeof query?.lean === 'function') {
    return query.lean();
  }

  return query;
}

export async function buildMappedSearchProperties({
  tenantModels,
  clientConfig,
  objectType,
  defaults,
}) {
  const properties = new Set(defaults);
  const FieldMapping = tenantModels?.FieldMapping;

  if (typeof FieldMapping?.find !== 'function') {
    return [...properties];
  }

  try {
    const mappings = await resolveQuery(FieldMapping.find({
      objectType,
      hubspotCredentialId: clientConfig?.hubspotCredentialId,
      isActive: true,
    }));

    if (Array.isArray(mappings)) {
      mappings.forEach((mapping) => {
        const targetField = String(mapping?.targetField || '').trim();

        if (targetField) {
          properties.add(targetField);
        }
      });
    }
  } catch (_error) {
    return [...properties];
  }

  return [...properties];
}

export default {
  buildMappedSearchProperties,
};
