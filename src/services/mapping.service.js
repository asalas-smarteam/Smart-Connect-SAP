function getTenantFieldMapping(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for mapping operations');
  }

  return tenantModels.FieldMapping;
}


const resolveValueByPath = (inputData, sourceField) => {
  if (!sourceField) {
    return null;
  }

  const pathParts = String(sourceField)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (pathParts.length === 0) {
    return null;
  }

  let currentValue = inputData;

  for (const segment of pathParts) {
    if (currentValue === null || typeof currentValue === 'undefined') {
      return null;
    }

    if (Array.isArray(currentValue)) {
      currentValue = currentValue[0];
      if (currentValue === null || typeof currentValue === 'undefined') {
        return null;
      }
    }

    currentValue = currentValue?.[segment];
  }

  if (Array.isArray(currentValue)) {
    return currentValue[0] ?? null;
  }

  return currentValue ?? null;
};

const mapFields = (inputData, mappings, objectType) => {
  const result = {};
  const resolvedInput = inputData ?? {};

  mappings
    .filter((mapping) => mapping.isActive ?? true)
    .forEach((m) => {
      result[m.targetField] = resolveValueByPath(resolvedInput, m.sourceField);
    });

  const mappedFields = { properties: result };

  if (objectType === 'deal' && inputData) {
    const specialDealFields = [
      'associatedContacts',
      'associatedCompanies',
      'associatedProducts',
    ];

    specialDealFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(inputData, field)) {
        mappedFields[field] = inputData[field];
      }
    });
  }

  return mappedFields;
};

const normalizeAssociations = (value) => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const mappingService = {
  async getMappings(hubspotCredentialId, objectType, tenantModels, sourceContext = 'businessPartner') {
    try {
      if (!hubspotCredentialId) {
        return [];
      }

      const FieldMapping = getTenantFieldMapping(tenantModels);
      const buildContextFilter = (context) => {
        if (context === 'businessPartner') {
          return {
            $or: [{ sourceContext: 'businessPartner' }, { sourceContext: { $exists: false } }],
          };
        }

        return { sourceContext: context };
      };

      let mappings = await FieldMapping.find({
        hubspotCredentialId,
        objectType,
        ...buildContextFilter(sourceContext),
      }).sort({ _id: 1 });

      if (mappings.length === 0 && sourceContext !== 'businessPartner') {
        mappings = await FieldMapping.find({
          hubspotCredentialId,
          objectType,
          ...buildContextFilter('businessPartner'),
        }).sort({ _id: 1 });
      }

      return mappings;
    } catch (error) {
      console.error('Failed to fetch mappings:', error);
      return [];
    }
  },

  async mapRecords(
    sapRecords,
    hubspotCredentialId,
    objectType,
    tenantModels,
    sourceContext = 'businessPartner'
  ) {
    try {
      const mappings = await this.getMappings(
        hubspotCredentialId,
        objectType,
        tenantModels,
        sourceContext
      );

      return sapRecords.map((record) => mapFields(record, mappings, objectType));
    } catch (error) {
      console.error('Failed to apply mappings:', error);
      return [];
    }
  },

  async getActiveMappingsByClientConfig(clientConfigId, tenantModels) {
    try {
      if (!clientConfigId) {
        return [];
      }

      const FieldMapping = getTenantFieldMapping(tenantModels);
      return await FieldMapping.find({ clientConfigId, isActive: true }).sort({ _id: 1 });
    } catch (error) {
      console.error('Failed to fetch mappings by clientConfig:', error);
      return [];
    }
  },

  async getMappingsByObjectType(
    hubspotCredentialId,
    objectType,
    sourceContext = 'businessPartner',
    tenantModels
  ) {
    try {
      if (!hubspotCredentialId || !objectType) {
        return [];
      }

      const FieldMapping = getTenantFieldMapping(tenantModels);

      let mappings = await FieldMapping.find({
        hubspotCredentialId,
        objectType,
        sourceContext,
        isActive: true,
      }).sort({ _id: 1 });

      if (mappings.length === 0 && sourceContext !== 'businessPartner') {
        mappings = await FieldMapping.find({
          hubspotCredentialId,
          objectType,
          sourceContext: 'businessPartner',
          isActive: true,
        }).sort({ _id: 1 });
      }

      return mappings;
    } catch (error) {
      console.error('Failed to fetch mappings by objectType:', error);
      return [];
    }
  },

  async applyMapping(
    inputData,
    hubspotCredentialId,
    objectType,
    tenantModels,
    sourceContext = 'businessPartner'
  ) {
    try {
      const mappings = await this.getMappings(
        hubspotCredentialId,
        objectType,
        tenantModels,
        sourceContext
      );

      return mapFields(inputData, mappings, objectType);
    } catch (error) {
      console.error('Failed to apply mappings:', error);
      return {};
    }
  },

  async applyDealWebhookMapping(payload, hubspotCredentialId, tenantModels) {
    try {
      const [dealMappings, contactMappings, companyMappings, productMappings] = await Promise.all([
        this.getMappings(hubspotCredentialId, 'deal', tenantModels),
        this.getMappings(hubspotCredentialId, 'contact', tenantModels),
        this.getMappings(hubspotCredentialId, 'company', tenantModels),
        this.getMappings(hubspotCredentialId, 'product', tenantModels),
      ]);

      const dealPayload = payload?.deal ?? null;
      const contactPayload = payload?.contact ?? null;
      const companyPayload = payload?.company ?? null;
      const lineItemsPayload = normalizeAssociations(payload?.line_items ?? []);

      const dealMapped = mapFields(dealPayload, dealMappings, 'deal');
      const contactMapped = contactPayload
        ? mapFields(contactPayload, contactMappings, 'contact').properties
        : null;
      const companyMapped = companyPayload
        ? mapFields(companyPayload, companyMappings, 'company').properties
        : null;
      const productMapped = lineItemsPayload.map(
        (item) => mapFields(item, productMappings, 'product').properties
      );

      return {
        properties: dealMapped.properties,
        associations: {
          contacts: normalizeAssociations(contactMapped),
          companies: normalizeAssociations(companyMapped),
          products: productMapped,
        },
      };
    } catch (error) {
      console.error('Failed to apply deal webhook mappings:', error);
      return { properties: {}, associations: { contacts: [], companies: [], products: [] } };
    }
  },
};

export default mappingService;
