import { FieldMapping } from '../config/database.js';

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
  async getMappings(hubspotCredentialId, objectType) {
    try {
      if (!hubspotCredentialId) {
        return [];
      }

      return await FieldMapping.findAll({
        where: { hubspotCredentialId, objectType },
        order: [['id', 'ASC']],
      });
    } catch (error) {
      console.error('Failed to fetch mappings:', error);
      return [];
    }
  },

  async mapRecords(sapRecords, hubspotCredentialId, objectType) {
    try {
      const mappings = await this.getMappings(hubspotCredentialId, objectType);

      return sapRecords.map((record) => mapFields(record, mappings, objectType));
    } catch (error) {
      console.error('Failed to apply mappings:', error);
      return [];
    }
  },

  async applyMapping(inputData, hubspotCredentialId, objectType) {
    try {
      const mappings = await this.getMappings(hubspotCredentialId, objectType);

      return mapFields(inputData, mappings, objectType);
    } catch (error) {
      console.error('Failed to apply mappings:', error);
      return {};
    }
  },
};

export default mappingService;
