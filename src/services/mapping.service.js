function getTenantFieldMapping(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for mapping operations');
  }

  return tenantModels.FieldMapping;
}

const mapFields = (inputData, mappings, objectType) => {
  const result = {};

  mappings
    .filter((mapping) => mapping.isActive ?? true)
    .forEach((m) => {
      result[m.targetField] = inputData[m.sourceField] || null;
    });

  const mappedFields = { properties: result };

  if (objectType === 'deal') {
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
};

export default mappingService;
