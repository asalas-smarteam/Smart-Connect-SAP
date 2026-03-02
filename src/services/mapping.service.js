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
  async getMappings(hubspotCredentialId, objectType, tenantModels) {
    try {
      if (!hubspotCredentialId) {
        return [];
      }

      const FieldMapping = getTenantFieldMapping(tenantModels);
      return await FieldMapping.find({ hubspotCredentialId, objectType }).sort({ _id: 1 });
    } catch (error) {
      console.error('Failed to fetch mappings:', error);
      return [];
    }
  },

  async mapRecords(sapRecords, hubspotCredentialId, objectType, tenantModels) {
    try {
      const mappings = await this.getMappings(hubspotCredentialId, objectType, tenantModels);

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

  async applyMapping(inputData, hubspotCredentialId, objectType, tenantModels) {
    try {
      const mappings = await this.getMappings(hubspotCredentialId, objectType, tenantModels);

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

