import { FieldMapping } from '../config/database.js';

const mapFields = (inputData, mappings) => {
  const result = {};

  mappings
    .filter((mapping) => mapping.isActive ?? true)
    .forEach((m) => {
      result[m.targetField] = inputData[m.sourceField] || null;
    });

  return {properties: result};
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

      return sapRecords.map((record) => mapFields(record, mappings));
    } catch (error) {
      console.error('Failed to apply mappings:', error);
      return [];
    }
  },

  async applyMapping(inputData, hubspotCredentialId, objectType) {
    try {
      const mappings = await this.getMappings(hubspotCredentialId, objectType);

      return mapFields(inputData, mappings);
    } catch (error) {
      console.error('Failed to apply mappings:', error);
      return {};
    }
  },
};

export default mappingService;
