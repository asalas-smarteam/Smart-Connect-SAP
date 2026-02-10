function getTenantFieldMapping(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for mapping operations');
  }

  return tenantModels.FieldMapping;
}

const mapFields = (inputData, mappings, objectType) => {
  const result = {};
  const resolvedInput = inputData ?? {};

  mappings
    .filter((mapping) => mapping.isActive ?? true)
    .forEach((m) => {
      result[m.targetField] = resolvedInput?.[m.sourceField] ?? null;
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
