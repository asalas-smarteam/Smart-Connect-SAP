import { FieldMapping, ClientConfig, HubspotCredentials } from '../config/database.js';

const mappingService = {
  async getMappings(clientConfigId, objectType) {
    try {
      if (clientConfigId) {
        const config = await ClientConfig.findByPk(clientConfigId);

        if (config) {
          const credentials = await HubspotCredentials.findOne({
            where: { clientConfigId: config.id },
          });

          if (!credentials) {
            return [];
          }

          return await FieldMapping.findAll({
            where: {
              hubspotCredentialId: credentials.id,
              objectType,
            },
            order: [['id', 'ASC']],
          });
        }
      }

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
