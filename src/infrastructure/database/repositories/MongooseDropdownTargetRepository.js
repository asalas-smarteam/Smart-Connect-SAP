function resolveFieldMappingModel(tenantContext) {
  const FieldMapping = tenantContext?.tenantModels?.FieldMapping;

  if (typeof FieldMapping?.find !== 'function') {
    throw new Error('Tenant context with FieldMapping model is required to resolve dropdown targets');
  }

  return FieldMapping;
}

async function resolveDocuments(query) {
  const result = typeof query?.lean === 'function' ? await query.lean() : await query;
  return Array.isArray(result) ? result : [];
}

// Which HubSpot properties does a SAP field feed? The answer lives in the
// FieldMappings the client already maintains, and it is deliberately read
// across every objectType: a field mapped on both company and contact must land
// in both dropdowns, under whatever targetField each mapping declares.
//
// sourceContext is NOT filtered. For dropdowns the direction is unambiguous
// (SAP -> HubSpot metadata), and the same field can legitimately be mapped from
// businessPartner, contactEmployee or product contexts; all of them name a real
// HubSpot property that needs the same option list.
export class MongooseDropdownTargetRepository {
  async findTargetsBySourceFields({ tenantContext, hubspotCredentialId, sourceFields }) {
    const fields = [...new Set((Array.isArray(sourceFields) ? sourceFields : [])
      .map((field) => String(field ?? '').trim())
      .filter(Boolean))];

    if (fields.length === 0) {
      return [];
    }

    if (!hubspotCredentialId) {
      throw new Error('hubspotCredentialId is required to resolve dropdown targets');
    }

    const FieldMapping = resolveFieldMappingModel(tenantContext);
    const mappings = await resolveDocuments(
      FieldMapping.find({
        hubspotCredentialId,
        sourceField: { $in: fields },
        isActive: true,
      }).sort({ _id: 1 })
    );

    const seen = new Set();

    return mappings.reduce((accumulator, mapping) => {
      const sourceField = String(mapping?.sourceField ?? '').trim();
      const objectType = String(mapping?.objectType ?? '').trim();
      const targetField = String(mapping?.targetField ?? '').trim();

      if (!sourceField || !objectType || !targetField) {
        return accumulator;
      }

      // The same (objectType, targetField) pair can appear twice across
      // sourceContexts; the option list would be identical, so writing it once
      // is enough.
      const key = `${sourceField}|${objectType}|${targetField}`;

      if (seen.has(key)) {
        return accumulator;
      }

      seen.add(key);
      accumulator.push({
        sourceField,
        objectType,
        targetField,
        sourceContext: mapping?.sourceContext ?? null,
      });

      return accumulator;
    }, []);
  }
}

export default MongooseDropdownTargetRepository;
