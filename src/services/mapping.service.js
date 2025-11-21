import { FieldMapping, ClientConfig } from '../config/database.js';

const mappingService = {
  async getMappings(clientConfigId, objectType) {
    try {
      return await FieldMapping.findAll({
        where: { clientConfigId, objectType },
        order: [['id', 'ASC']],
      });
    } catch (error) {
      console.error('Failed to fetch mappings:', error);
      return [];
    }
  },

  async applyMapping(inputData, clientConfigId, objectType) {
    try {
      const mappings = await this.getMappings(clientConfigId, objectType);
      const result = {};

      mappings.forEach((m) => {
        result[m.targetField] = inputData[m.sourceField] || null;
      });

      return result;
    } catch (error) {
      console.error('Failed to apply mappings:', error);
      return {};
    }
  },
};

export default mappingService;
